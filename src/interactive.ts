import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LearningClassification, LearningRecord } from "./types.ts";
import { classifyIssueWithModel, draftLearning, recommendTarget } from "./draft.ts";
import { bounded, createLearning, listLearnings, moveLearning, readLearning, saveLearning } from "./store.ts";
import { applyRepoAgentsRule, resolveRepoAgentsPath } from "./apply.ts";
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

function roleFromMessage(message: unknown): PickableTurn["role"] {
  if (message && typeof message === "object" && "role" in message) {
    const role = String(message.role);
    if (role === "assistant" || role === "tool" || role === "user") return role;
  }
  return "unknown";
}

function excerptFromEntry(entry: MessageEntry): string {
  if (entry.type !== "message") return "";
  const message = entry.message as { content?: unknown; toolName?: string; command?: string; output?: string };
  return bounded(textFromContent(message.content) || message.output || message.command || "(no text)", 1200).replace(/\s+/g, " ").trim();
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

export function recentPickableTurns(ctx: ExtensionCommandContext, limit = 18): PickableTurn[] {
  const entries = ctx.sessionManager.getEntries();
  const rawTurns: RawTurn[] = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => {
      const role = roleFromMessage(entry.message);
      const excerpt = excerptFromEntry(entry);
      return { id: entry.id, role, timestamp: entry.timestamp, excerpt };
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

  const dedupedTurns = lastAssistant ? turns.filter((turn) => turn.id !== lastAssistant.id) : turns;
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

function renderFullDraft(record: LearningRecord): string {
  return [
    `# ${record.id}`,
    `status: ${record.status}`,
    `classification: ${classificationLabel(record.classification)}`,
    `target: ${record.recommendedTarget.kind}:${record.recommendedTarget.path}`,
    `risk: ${record.draft?.risk ?? "(none)"}`,
    `duplicate: ${record.draft?.duplicateCheck.similarExistingRule ?? "none found"}`,
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
  return `${record.id} · ${classificationLabel(record.classification)} · ${bounded(rule, 180).replace(/\s+/g, " ")} · ${bounded(record.issue.description, 120).replace(/\s+/g, " ")}`;
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
  const resolvedTarget = resolveRepoAgentsPath(root, record);
  const targetPath = resolvedTarget.ok ? resolvedTarget.relPath : record.recommendedTarget.path;
  const applyLabel = `Apply rule to ${targetPath}`;
  const backLabel = "Keep pending / Back";
  const rejectLabel = "Reject draft";
  const action = await ctx.ui.select("Apply or reject this draft", [backLabel, applyLabel, rejectLabel]);
  if (action === applyLabel) {
    const target = `${record.recommendedTarget.kind}:${targetPath}`;
    const rule = record.draft?.proposedText ?? "(none)";
    const consequence = `Will edit: ${targetPath}\nSection: ## Agent Learnings\nChange: append single bullet if not already present\nTarget: ${target}\nRule to append: ${rule}`;
    const ui = ctx.ui as typeof ctx.ui & { confirm?: (title: string, message: string) => Promise<boolean> };
    const confirmed = ui.confirm
      ? await ui.confirm(`Confirm applying rule to ${targetPath}`, consequence)
      : (await ctx.ui.select(`Confirm applying rule to ${targetPath}\n\n${consequence}`, [backLabel, applyLabel])) === applyLabel;
    if (!confirmed) return { ok: false, message: "Cancelled. Draft left pending." };
    const result = applyRepoAgentsRule(root, record);
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
  const action = await ctx.ui.select("Learning loop", [capture, review, browse, note]);
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

  let picked: PickableTurn | undefined;
  while (!picked) {
    const labels = turns.map((turn) => turn.label);
    const pickedLabel = await ctx.ui.select("Select the turn to learn from", labels);
    if (!pickedLabel) return { ok: false, message: "Cancelled. No learning created." };
    const candidate = turns[labels.indexOf(pickedLabel)];
    if (!candidate) return { ok: false, message: "Cancelled. Selected turn was not found." };

    await ctx.ui.editor("Read-only preview: selected turn", renderTurnPreview(candidate));
    const action = await ctx.ui.select("Use this turn?", ["Use this turn", "Back to picker", "Cancel"]);
    if (action === "Use this turn") picked = candidate;
    else if (action === "Back to picker") continue;
    else return { ok: false, message: "Cancelled. No learning created." };
  }

  const issue = (await ctx.ui.input("What went wrong?", suggestedIssue(picked)))?.trim();
  if (!issue) return { ok: false, message: "Cancelled. No learning created." };

  const desiredFutureBehavior = (await ctx.ui.editor("What should Pi do differently next time?", "Optional: keep it durable, not one-off."))?.trim() || undefined;
  const classification: LearningClassification = await classifyIssueWithModel(root, `${issue}\n${picked.excerpt}\n${desiredFutureBehavior ?? ""}`, ctx);
  const config = loadConfig(root);
  const target = recommendTarget(classification);
  if (target.kind === "repo-agents") target.path = config.repoAgentsPath;
  const record = createLearning(root, {
    source: { selector: "turn-id", turnId: picked.sourceTurnId ?? picked.id, role: picked.role, excerpt: bounded(picked.excerpt, config.maxExcerptChars) },
    issue: { description: bounded(issue, 1000), desiredFutureBehavior: desiredFutureBehavior ? bounded(desiredFutureBehavior, 1000) : undefined },
    classification,
    recommendedTarget: target,
  });
  record.draft = await draftLearning(root, record, ctx);
  saveLearning(root, record);

  return { ok: true, record, message: renderReview(record) };
}
