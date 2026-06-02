import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LearningClassification, LearningRecord } from "./types.ts";
import { classifyIssueWithModel, draftLearning, recommendTarget } from "./draft.ts";
import { bounded, createLearning, listLearnings, moveLearning, readLearning, saveLearning } from "./store.ts";
import { applyLearningRule, resolveLearningTarget } from "./apply.ts";
import { loadConfig } from "./config.ts";

type MessageEntry = ReturnType<ExtensionCommandContext["sessionManager"]["getEntries"]>[number];

type PickableTurn = {
  id: string;
  sourceTurnId?: string;
  role: "assistant" | "tool" | "user" | "unknown";
  timestamp: string;
  excerpt: string;
  label: string;
  reason?: string;
  evidenceTurnId?: string;
  evidenceExcerpt?: string;
  source: "session" | "subagent";
  score: number;
};

type RawTurn = Omit<PickableTurn, "label" | "reason" | "score" | "evidenceTurnId" | "evidenceExcerpt">;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    }).filter(Boolean).join(" ");
  }
  return "";
}

function isSubagentMessage(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && "customType" in message && String((message as { customType?: unknown }).customType) === "subagent-notification");
}

function roleFromMessage(message: unknown): PickableTurn["role"] {
  if (isSubagentMessage(message)) return "assistant";
  if (message && typeof message === "object" && "role" in message) {
    const role = String(message.role);
    if (role === "assistant" || role === "tool" || role === "user") return role;
  }
  return "unknown";
}

function excerptFromEntry(entry: MessageEntry): string {
  if (entry.type !== "message") return "";
  const message = entry.message as { content?: unknown; toolName?: string; command?: string; output?: string; details?: Record<string, unknown>; customType?: unknown };
  if (isSubagentMessage(message)) {
    const details = message.details ?? {};
    const pieces = [
      details.description ? `subagent: ${String(details.description)}` : "subagent result",
      details.status ? `status: ${String(details.status)}` : undefined,
      details.error ? `error: ${String(details.error)}` : undefined,
      details.resultPreview ? String(details.resultPreview) : undefined,
      details.outputFile ? `transcript: ${String(details.outputFile)}` : undefined,
      textFromContent(message.content),
    ];
    return bounded(pieces.filter(Boolean).join("\n"), 1200).replace(/\s+/g, " ").trim();
  }
  return bounded(textFromContent(message.content) || message.output || message.command || "(no text)", 1200).replace(/\s+/g, " ").trim();
}

function sourceTurnIdFromMessage(message: unknown): string | undefined {
  if (!isSubagentMessage(message)) return undefined;
  const details = (message as { details?: Record<string, unknown> }).details;
  const id = details?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function sourceFromMessage(message: unknown): PickableTurn["source"] {
  return isSubagentMessage(message) ? "subagent" : "session";
}

function outputFileFromMessage(message: unknown): string | undefined {
  if (!isSubagentMessage(message)) return undefined;
  const details = (message as { details?: Record<string, unknown> }).details;
  const outputFile = details?.outputFile;
  return typeof outputFile === "string" && outputFile.trim() ? outputFile.trim() : undefined;
}

function roleFromTranscriptEntry(entry: Record<string, unknown>): PickableTurn["role"] {
  const message = entry.message;
  if (message && typeof message === "object" && "role" in message) {
    const role = String((message as { role?: unknown }).role);
    if (role === "assistant" || role === "tool" || role === "user") return role;
  }
  if (entry.type === "assistant") return "assistant";
  if (entry.type === "toolResult") return "tool";
  if (entry.type === "user") return "user";
  return "unknown";
}

function transcriptExcerpt(entry: Record<string, unknown>): string {
  const message = entry.message as { content?: unknown; output?: string; command?: string } | undefined;
  return bounded(textFromContent(message?.content) || message?.output || message?.command || "(no text)", 1200).replace(/\s+/g, " ").trim();
}

function readSubagentTranscriptTurns(outputFile: string | undefined, cwd: string, notificationId: string, fallbackAgentId?: string): RawTurn[] {
  if (!outputFile) return [];
  const path = isAbsolute(outputFile) ? outputFile : resolve(cwd, outputFile);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const role = roleFromTranscriptEntry(parsed);
        const excerpt = transcriptExcerpt(parsed);
        const agentId = typeof parsed.agentId === "string" && parsed.agentId.trim() ? parsed.agentId.trim() : fallbackAgentId;
        const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date(0).toISOString();
        const turn: RawTurn = { id: `${notificationId}:${agentId ?? "subagent"}:${index}`, role, timestamp, excerpt, source: "subagent" };
        if (agentId) turn.sourceTurnId = agentId;
        return turn;
      })
      .filter((turn) => turn.role !== "unknown" && Boolean(turn.excerpt));
  } catch {
    return [];
  }
}

function issueSignal(text: string): boolean {
  return /\b(fail(?:ed|ing)?|error|exit code [1-9]|exception|traceback|panic|timeout|denied|blocked|not enough|red|broken)\b/i.test(text);
}

function overclaimSignal(text: string): boolean {
  return /\b(pass(?:ed|es)?|green|fixed|done|works|verified|all checks|tests pass|ci is green|updated?|changed|edited|patched|wrote|created|modified)\b/i.test(text);
}

function fileRefs(text: string): string[] {
  const matches = text.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/g) ?? [];
  return [...new Set(matches.map((match) => match.replace(/^`|`$/g, "")))];
}

function isTestText(text: string): boolean {
  return /\b(test|tests|pytest|vitest|jest|pnpm test|npm test|go test|cargo test|all checks|ci)\b/i.test(text);
}

function isLintText(text: string): boolean {
  return /\b(lint|eslint|ruff|clippy|golangci-lint|typecheck|tsc)\b/i.test(text);
}

function isFileUpdateClaim(text: string): boolean {
  return /\b(updated?|changed|edited|patched|wrote|created|modified|fixed)\b/i.test(text) && fileRefs(text).length > 0;
}

function semanticMatchScore(claim: string, toolOutput: string): number {
  let score = 0;
  const claimFiles = fileRefs(claim);
  if (claimFiles.length > 0) {
    for (const file of claimFiles) {
      if (toolOutput.includes(file) || toolOutput.includes(file.split("/").pop() ?? file)) score += 5;
    }
  }
  if (isFileUpdateClaim(claim) && /\b(patch|write_file|old_string|file|modified|created|updated)\b/i.test(toolOutput)) score += 3;
  if (isTestText(claim) && isTestText(toolOutput)) score += 4;
  if (isLintText(claim) && isLintText(toolOutput)) score += 4;
  return score;
}

function findContradictingTool(turns: RawTurn[], index: number): RawTurn | undefined {
  const claim = turns[index]?.excerpt ?? "";
  const candidates: RawTurn[] = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = turns[cursor];
    if (!candidate) break;
    if (candidate.role === "assistant") break;
    if (candidate.role === "tool" && issueSignal(candidate.excerpt)) candidates.push(candidate);
  }
  if (candidates.length === 0) return undefined;
  const ranked = candidates
    .map((candidate, order) => ({ candidate, score: semanticMatchScore(claim, candidate.excerpt), order }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked[0]?.candidate;
}

function qualityHint(role: PickableTurn["role"], excerpt: string, contradictingTool?: RawTurn): { score: number; reason?: string } {
  if (role === "assistant" && overclaimSignal(excerpt) && contradictingTool) return { score: 120, reason: `after tool failure ${contradictingTool.id}` };
  if (role === "assistant" && overclaimSignal(excerpt)) return { score: 70, reason: "verification claim" };
  if (role === "tool" && issueSignal(excerpt)) return { score: 60, reason: "tool failure" };
  if (role === "assistant") return { score: 30 };
  if (role === "tool") return { score: 20 };
  return { score: 5 };
}

function reasonCategory(turn: PickableTurn | Omit<PickableTurn, "label">): string {
  if (turn.reason?.startsWith("after tool failure")) return "overclaim/tool-failure";
  if (turn.reason === "verification claim") return "verification-claim";
  if (turn.reason === "tool failure") return "tool-failure";
  return "general";
}

function formatTurnLabel(turn: Omit<PickableTurn, "label">, turnsAgo = 0): string {
  const disambiguator = `#${turn.id}`;
  const prefix = turn.id === "__last_assistant__" ? "[last]" : turn.reason ? "[likely]" : "[recent]";
  if (prefix === "[last]") return "[last] last assistant response";
  if (turn.source === "subagent") return `[likely] subagent result · ${reasonCategory(turn)} · ${disambiguator}`;
  if (prefix === "[likely]" && turn.reason?.startsWith("after tool failure")) return `[likely] claimed success after failed tool · assistant · ${disambiguator}`;
  if (prefix === "[likely]" && turn.reason === "verification claim") return `[likely] verification claim · ${turn.role} · ${disambiguator}`;
  if (prefix === "[likely]" && turn.reason === "tool failure") return `[likely] failed tool output · ${turn.role} · ${disambiguator}`;
  const plural = turnsAgo === 1 ? "turn" : "turns";
  return `[recent] ${turn.role} response · ${turnsAgo} ${plural} ago · ${disambiguator}`;
}

function renderTurnPreview(turn: PickableTurn): string {
  return [
    `role: ${turn.role}`,
    turn.reason ? `reason: ${reasonCategory(turn)}` : undefined,
    "",
    "selected excerpt:",
    turn.excerpt,
    turn.evidenceExcerpt ? "" : undefined,
    turn.evidenceExcerpt ? "evidence excerpt:" : undefined,
    turn.evidenceExcerpt,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function suggestedIssue(turn: PickableTurn): string {
  if (turn.reason?.startsWith("after tool failure") || (turn.role === "assistant" && turn.evidenceExcerpt && issueSignal(turn.evidenceExcerpt) && overclaimSignal(turn.excerpt))) {
    return "Claimed success after tool output showed failure.";
  }
  if (turn.reason === "verification claim") return "Claimed verification without enough evidence.";
  if (turn.reason === "tool failure") return "Tool output showed a failure that should be handled.";
  if (turn.role === "assistant") return "Assistant response needs a more reliable behavior next time.";
  return "This turn exposed behavior Pi should improve.";
}

function selectedTurnsIssue(turns: PickableTurn[]): string {
  if (turns.length === 1) return suggestedIssue(turns[0]!);
  return "Multiple selected turns together show behavior Pi should improve.";
}

function combinedSourceRole(turns: PickableTurn[]): PickableTurn["role"] {
  const first = turns[0]?.role ?? "unknown";
  return turns.every((turn) => turn.role === first) ? first : "unknown";
}

function combinedSourceExcerpt(turns: PickableTurn[]): string {
  return turns.map((turn, index) => [
    `--- selected turn ${index + 1}/${turns.length} · ${turn.role} · ${turn.sourceTurnId ?? turn.id} ---`,
    turn.excerpt,
    turn.evidenceExcerpt ? "evidence excerpt:" : undefined,
    turn.evidenceExcerpt,
  ].filter((line): line is string => line !== undefined).join("\n")).join("\n\n");
}

export function recentPickableTurns(ctx: ExtensionCommandContext, limit = 18): PickableTurn[] {
  const entries = ctx.sessionManager.getEntries();
  const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd();
  const rawTurns: RawTurn[] = entries
    .filter((entry) => entry.type === "message")
    .flatMap((entry) => {
      const role = roleFromMessage(entry.message);
      const excerpt = excerptFromEntry(entry);
      const sourceTurnId = sourceTurnIdFromMessage(entry.message);
      const turn: RawTurn = { id: entry.id, role, timestamp: entry.timestamp, excerpt, source: sourceFromMessage(entry.message) };
      if (sourceTurnId) turn.sourceTurnId = sourceTurnId;
      const transcriptTurns = readSubagentTranscriptTurns(outputFileFromMessage(entry.message), cwd, entry.id, sourceTurnId);
      return [turn, ...transcriptTurns];
    })
    .filter((turn): turn is RawTurn => Boolean(turn.excerpt) && turn.role !== "unknown");

  const turns = rawTurns.map((turn, index) => {
    const contradictingTool = findContradictingTool(rawTurns, index);
    const hint = qualityHint(turn.role, turn.excerpt, contradictingTool);
    const recency = Math.min(index, 20);
    const pickable = {
      ...turn,
      score: hint.score + recency,
      reason: hint.reason,
      evidenceTurnId: contradictingTool?.id,
      evidenceExcerpt: contradictingTool?.excerpt,
    } satisfies Omit<PickableTurn, "label">;
    return { ...pickable, label: formatTurnLabel(pickable, rawTurns.length - 1 - index) } satisfies PickableTurn;
  });

  const lastAssistant = [...turns].reverse().find((turn) => turn.role === "assistant");
  const fastPath = lastAssistant
    ? [{ ...lastAssistant, id: "__last_assistant__", sourceTurnId: lastAssistant.id, score: lastAssistant.score + 10_000, label: formatTurnLabel({ ...lastAssistant, id: "__last_assistant__", sourceTurnId: lastAssistant.id, score: lastAssistant.score + 10_000 }) }]
    : [];

  const dedupedTurns = lastAssistant && lastAssistant.source !== "subagent" ? turns.filter((turn) => turn.id !== lastAssistant.id) : turns;
  const ranked = [...dedupedTurns].sort((a, b) => b.score - a.score).slice(0, limit);
  return [...fastPath, ...ranked];
}

function renderReview(record: LearningRecord): string {
  return [
    `created: ${record.id}`,
    `pending learning/proposed rule created; no repo rule applied yet.`,
    `source: ${record.source.role} turn ${record.source.turnId ?? "unknown"}`,
    `issue: ${record.issue.description}`,
    record.issue.desiredFutureBehavior ? `future: ${record.issue.desiredFutureBehavior}` : undefined,
    "",
    "review:",
    `target: ${record.recommendedTarget.kind}:${record.recommendedTarget.path}`,
    `classification: ${classificationLabel(record.classification)}`,
    `rule: ${record.draft?.proposedText ?? "(none)"}`,
    `rationale: ${record.draft?.rationale ?? "(none)"}`,
    "",
    `next: /learn review`,
    `target if approved: ${record.recommendedTarget.path}`,
    `approve with: /learn approve ${record.id} --confirm`,
    `reject with: /learn reject ${record.id} <reason>`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderDuplicateBlock(record: LearningRecord): string {
  const candidates = record.draft?.duplicateCheck.similar ?? [];
  if (!candidates.length) return "duplicate check:\nnone found";
  const top = candidates[0]!;
  return [
    "duplicate check:",
    "similar existing rules found",
    "",
    "top match:",
    `${top.path}${top.line ? `:${top.line}` : ""} · score ${top.score}`,
    top.existingText,
    "",
    `recommended: ${record.draft?.duplicateCheck.suggestedAction ?? "update"}`,
  ].join("\n");
}

function renderFullDraft(record: LearningRecord): string {
  return [
    `# ${record.id}`,
    `status: ${record.status}`,
    `classification: ${classificationLabel(record.classification)}`,
    `target: ${record.recommendedTarget.kind}:${record.recommendedTarget.path}`,
    `risk: ${record.draft?.risk ?? "(none)"}`,
    `duplicate: ${record.draft?.duplicateCheck.similarExistingRule ?? "none found"}`,
    renderDuplicateBlock(record),
    `searched paths: ${record.draft?.duplicateCheck.searched.join(", ") || "(none)"}`,
    "",
    "issue:",
    record.issue.description,
    record.issue.desiredFutureBehavior ? `\nfuture behavior:\n${record.issue.desiredFutureBehavior}` : undefined,
    "",
    "source excerpt:",
    record.source.excerpt,
    "",
    "draft rule:",
    record.draft?.proposedText || "(none)",
    "",
    "rationale:",
    record.draft?.rationale || "(none)",
    "",
    `approve: /learn approve ${record.id} --confirm`,
    `reject: /learn reject ${record.id} <reason>`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatDraftLabel(record: LearningRecord): string {
  const rule = record.draft?.proposedText || "(no draft yet)";
  const prefix = record.draft?.duplicateCheck.similar?.length ? "[similar] " : "";
  return `${prefix}${record.id} · ${classificationLabel(record.classification)} · ${bounded(rule, 180).replace(/\s+/g, " ")} · ${bounded(record.issue.description, 120).replace(/\s+/g, " ")}`;
}

function classificationLabel(classification: LearningClassification): string {
  return ({
    verification_overclaim: "Verification overclaim",
    scope_drift: "Scope drift",
    unsafe_edit: "Unsafe edit",
    wrong_tool: "Wrong tool",
    context_miss: "Context miss",
    stale_data: "Stale data",
    transient: "Transient / note only",
    other: "Other",
  } as Record<LearningClassification, string>)[classification] ?? classification;
}

export async function runDraftReview(root: string, ctx: ExtensionCommandContext): Promise<{ ok: true; message: string; record: LearningRecord } | { ok: false; message: string }> {
  if (!ctx.hasUI) return { ok: false, message: "UI draft review unavailable in this mode. No learning was lost. Use: /learn pending, /learn show <id>, /learn approve <id> --confirm, or /learn reject <id>." };
  const pending = listLearnings(root);
  const drafts = pending.filter((record) => record.draft);
  if (pending.length === 0) return { ok: false, message: "No pending learnings. Use /learn pick or /learn note <issue> first." };
  if (drafts.length === 0) return { ok: false, message: `Found ${pending.length} pending learning${pending.length === 1 ? "" : "s"} without drafts. Use /learn draft <id> first.` };

  const labels = drafts.map(formatDraftLabel);
  const pickedLabel = await ctx.ui.select("Select draft to review", labels);
  if (!pickedLabel) return { ok: false, message: "Cancelled. No draft selected." };
  const record = drafts[labels.indexOf(pickedLabel)];
  if (!record) return { ok: false, message: "Cancelled. Selected draft was not found." };

  await ctx.ui.editor("Read-only preview: learning draft", renderFullDraft(record));
  const resolvedTarget = resolveLearningTarget(root, record);
  const config = loadConfig(root);
  const projectPath = config.repoAgentsPath;
  const projectLabel = `Apply to project rules (${projectPath})`;
  const globalAgentsLabel = `Apply to global Pi rules (${config.globalAgentsPath})`;
  const globalSystemLabel = `Apply to global Pi system append (${config.globalSystemPath})`;
  const backLabel = "Keep pending / Back";
  const rejectLabel = "Reject draft";
  const updateLabel = "Update existing rule";
  const appendLabel = "Append as new rule";
  const similar = record.draft?.duplicateCheck.similar ?? [];
  const action = similar.length
    ? await ctx.ui.select("Similar existing rules found", [updateLabel, appendLabel, "Reject as duplicate", backLabel])
    : await ctx.ui.select("Apply or reject this draft", [backLabel, projectLabel, globalAgentsLabel, globalSystemLabel, rejectLabel]);
  if (action === updateLabel) {
    record.recommendedTarget = { kind: "repo-agents", path: config.repoAgentsPath };
    const candidate = similar[0]!;
    const selectedPath = `${candidate.path}${candidate.line ? `:${candidate.line}` : ""}`;
    const rule = record.draft?.proposedText ?? "(none)";
    const consequence = `Will edit: ${candidate.path}\nChange: replace one existing bullet in ## Agent Learnings\nExisting line: ${candidate.line ?? "unknown"}\n\nBefore:\n${candidate.existingText}\n\nAfter:\n${rule}\n\nThis will not append a new bullet.`;
    await ctx.ui.editor("Read-only preview: update existing rule", consequence);
    const ui = ctx.ui as typeof ctx.ui & { confirm?: (title: string, message: string) => Promise<boolean> };
    const confirmed = ui.confirm
      ? await ui.confirm(`Confirm updating rule in ${candidate.path}`, consequence)
      : (await ctx.ui.select(`Confirm updating rule in ${candidate.path}\n\n${consequence}`, [backLabel, updateLabel])) === updateLabel;
    if (!confirmed) return { ok: false, message: "Cancelled. Draft left pending." };
    const result = applyLearningRule(root, record, { update: candidate });
    if (result.applied) {
      record.appliedAt = new Date().toISOString();
      moveLearning(root, record, "applied");
    }
    return { ok: true, record, message: result.message || `Updated existing rule in ${selectedPath}` };
  }
  if (action === "Reject as duplicate") {
    record.rejectionReason = "Duplicate / already covered";
    moveLearning(root, record, "rejected");
    return { ok: true, record, message: `rejected duplicate: ${record.id}` };
  }
  if (action === appendLabel) record.recommendedTarget = { kind: "repo-agents", path: config.repoAgentsPath };
  if (action === projectLabel || action === globalAgentsLabel || action === globalSystemLabel || action === appendLabel) {
    if (action === globalAgentsLabel) record.recommendedTarget = { kind: "global-agents", path: config.globalAgentsPath };
    if (action === globalSystemLabel) record.recommendedTarget = { kind: "global-system", path: config.globalSystemPath };
    if (action === projectLabel) record.recommendedTarget = { kind: "repo-agents", path: config.repoAgentsPath };
    const selectedTarget = resolveLearningTarget(root, record);
    const selectedPath = selectedTarget.ok ? selectedTarget.displayPath : record.recommendedTarget.path;
    const target = `${record.recommendedTarget.kind}:${selectedPath}`;
    const rule = record.draft?.proposedText ?? "(none)";
    const consequence = `Will edit: ${selectedPath}\nSection: ## Agent Learnings\nChange: append single bullet if not already present\nTarget: ${target}\n${selectedTarget.ok && selectedTarget.global ? "Scope: GLOBAL Pi rules; affects all projects\n" : ""}Rule to append: ${rule}`;
    const ui = ctx.ui as typeof ctx.ui & { confirm?: (title: string, message: string) => Promise<boolean> };
    const confirmed = ui.confirm
      ? await ui.confirm(`Confirm applying rule to ${selectedPath}`, consequence)
      : (await ctx.ui.select(`Confirm applying rule to ${selectedPath}\n\n${consequence}`, [backLabel, action ?? "Apply"])) === action;
    if (!confirmed) return { ok: false, message: "Cancelled. Draft left pending." };
    const result = applyLearningRule(root, record, { allowGlobal: selectedTarget.ok && selectedTarget.global });
    if (result.applied) {
      record.appliedAt = new Date().toISOString();
      moveLearning(root, record, "applied");
    }
    return { ok: true, record, message: result.message };
  }
  if (action === rejectLabel) {
    const reasons = ["Duplicate / already covered", "Too specific / not durable", "Wrong target", "Bad draft wording", "Keep as note only / do not apply rule", "Not actually a mistake", "Other..."];
    const structuredReason = await ctx.ui.select("Reject reason", reasons);
    if (!structuredReason) return { ok: false, message: "Cancelled. Draft left pending." };
    const detail = (await ctx.ui.input("Optional rejection detail", "Optional detail"))?.trim();
    record.rejectionReason = detail ? `${structuredReason} — ${detail}` : structuredReason;
    moveLearning(root, record, "rejected");
    return { ok: true, record, message: `rejected: ${record.id}` };
  }
  return { ok: false, message: "Cancelled. Draft left pending." };
}

function shortLine(text: string, max = 100): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function browseLabel(record: LearningRecord): string {
  return `${record.status} · ${record.id} · ${classificationLabel(record.classification)} · ${shortLine(record.issue.description)}`;
}

async function createQuickNote(root: string, issue: string, ctx: ExtensionCommandContext): Promise<{ ok: true; record: LearningRecord; message: string } | { ok: false; message: string }> {
  const trimmed = issue.trim();
  if (!trimmed) return { ok: false, message: "Cancelled. No learning created." };
  const config = loadConfig(root);
  const classification = await classifyIssueWithModel(root, trimmed, ctx);
  const target = recommendTarget(classification);
  if (target.kind === "repo-agents") target.path = config.repoAgentsPath;
  const record = createLearning(root, { source: { selector: "manual", role: "unknown", excerpt: bounded(trimmed, config.maxExcerptChars) }, issue: { description: bounded(trimmed, 1000) }, classification, recommendedTarget: target });
  record.draft = await draftLearning(root, record, ctx);
  saveLearning(root, record);
  return { ok: true, record, message: `captured: ${record.id}\nno repo rule applied\nnext: /learn` };
}

export async function runQuickNote(root: string, ctx: ExtensionCommandContext, issue?: string): Promise<{ ok: true; record: LearningRecord; message: string } | { ok: false; message: string }> {
  if (issue !== undefined) return createQuickNote(root, issue, ctx);
  if (!ctx.hasUI) return { ok: false, message: "usage: /learn note <what went wrong>" };
  const prompted = await ctx.ui.input("What went wrong?", "Briefly describe the mistake or behavior to improve.");
  return createQuickNote(root, prompted ?? "", ctx);
}

export async function runBrowseLearnings(root: string, ctx: ExtensionCommandContext): Promise<{ ok: true; message: string; record: LearningRecord } | { ok: false; message: string }> {
  if (!ctx.hasUI) return { ok: false, message: "UI browse unavailable in this mode. Use: /learn pending or /learn show <id>." };
  const records = (["pending", "applied", "rejected"] as const).flatMap((status) => listLearnings(root, status));
  if (!records.length) return { ok: false, message: "No learnings found. Use /learn pick or /learn note <issue> first." };
  const labels = records.map(browseLabel);
  const pickedLabel = await ctx.ui.select("Browse learnings", labels);
  if (!pickedLabel) return { ok: false, message: "Cancelled. No learning selected." };
  const picked = records[labels.indexOf(pickedLabel)];
  if (!picked) return { ok: false, message: "Cancelled. Selected learning was not found." };
  const record = readLearning(root, picked.id);
  await ctx.ui.editor("Learning detail", renderFullDraft(record));
  return { ok: true, record, message: `shown: ${record.id}` };
}

export async function runLearningMainMenu(root: string, ctx: ExtensionCommandContext): Promise<{ ok: true; message: string; record?: LearningRecord } | { ok: false; message: string }> {
  if (!ctx.hasUI) return { ok: false, message: "/learn opens the learning menu when UI is available.\nUse: /learn note <what went wrong>\nAdvanced fallback: /learn review, /learn pending, /learn show <id>, /learn approve <id> --confirm, /learn reject <id> [reason]" };
  const capture = "Capture from recent turn";
  const review = "Review pending drafts";
  const browse = "Browse learnings";
  const note = "Quick note";
  const action = await ctx.ui.select("Pi learnings", [capture, review, browse, note]);
  if (action === capture) return runInteractiveLearn(root, ctx);
  if (action === review) return runDraftReview(root, ctx);
  if (action === browse) return runBrowseLearnings(root, ctx);
  if (action === note) return runQuickNote(root, ctx);
  return { ok: false, message: "Cancelled. No learning action selected." };
}

export async function runInteractiveLearn(root: string, ctx: ExtensionCommandContext): Promise<{ ok: true; record: LearningRecord; message: string } | { ok: false; message: string }> {
  if (!ctx.hasUI) {
    return { ok: false, message: "UI picker unavailable in this mode. No learning was created. Use: /learn note <what went wrong>" };
  }

  const turns = recentPickableTurns(ctx);
  if (turns.length === 0) {
    return { ok: false, message: "No selectable session turns found. Use: /learn note <what went wrong>" };
  }

  const picked: PickableTurn[] = [];
  while (true) {
    const selectedIds = new Set(picked.map((turn) => turn.id));
    const labels = turns
      .filter((turn) => !selectedIds.has(turn.id))
      .map((turn) => turn.label);
    const pickerOptions = picked.length > 0 ? [`Use ${picked.length} selected`, ...labels] : labels;
    const pickedLabel = await ctx.ui.select("Select the turn to learn from", pickerOptions);
    if (!pickedLabel) return { ok: false, message: "Cancelled. No learning created." };
    if (pickedLabel.startsWith("Use ") && pickedLabel.endsWith(" selected")) break;
    const candidate = turns.find((turn) => turn.label === pickedLabel);
    if (!candidate) return { ok: false, message: "Cancelled. Selected turn was not found." };

    await ctx.ui.editor("Read-only preview: selected turn", renderTurnPreview(candidate));
    const action = await ctx.ui.select("Use this turn?", ["Use selected turns", "Add this turn and pick another", "Back to picker", "Cancel"]);
    if (action === "Use selected turns" || action === "Use this turn") {
      if (!picked.some((turn) => turn.id === candidate.id)) picked.push(candidate);
      break;
    }
    if (action === "Add this turn and pick another") {
      if (!picked.some((turn) => turn.id === candidate.id)) picked.push(candidate);
      continue;
    }
    if (action === "Back to picker") continue;
    return { ok: false, message: "Cancelled. No learning created." };
  }

  if (picked.length === 0) return { ok: false, message: "Cancelled. No learning created." };
  const combinedExcerpt = combinedSourceExcerpt(picked);
  const issue = (await ctx.ui.input("What went wrong?", selectedTurnsIssue(picked)))?.trim();
  if (!issue) return { ok: false, message: "Cancelled. No learning created." };

  const desiredFutureBehavior = (await ctx.ui.editor("What should Pi do differently next time?", "Optional: keep it durable, not one-off."))?.trim() || undefined;
  const classification: LearningClassification = await classifyIssueWithModel(root, `${issue}\n${combinedExcerpt}\n${desiredFutureBehavior ?? ""}`, ctx);
  const config = loadConfig(root);
  const target = recommendTarget(classification);
  if (target.kind === "repo-agents") target.path = config.repoAgentsPath;
  const record = createLearning(root, {
    source: { selector: "turn-id", turnId: picked.map((turn) => turn.sourceTurnId ?? turn.id).join(","), role: combinedSourceRole(picked), excerpt: bounded(combinedExcerpt, config.maxExcerptChars) },
    issue: { description: bounded(issue, 1000), desiredFutureBehavior: desiredFutureBehavior ? bounded(desiredFutureBehavior, 1000) : undefined },
    classification,
    recommendedTarget: target,
  });
  record.draft = await draftLearning(root, record, ctx);
  saveLearning(root, record);

  return { ok: true, record, message: renderReview(record) };
}
