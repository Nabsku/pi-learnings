import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LearningClassification, LearningRecord } from "./types.ts";
import { classifyIssueWithModel, draftLearning, recommendTarget } from "./draft.ts";
import { bounded, createLearning, listLearnings, moveLearning, saveLearning } from "./store.ts";
import { applyRepoAgentsRule } from "./apply.ts";
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

function formatTurnLabel(turn: Omit<PickableTurn, "label">): string {
  const prefix = turn.id === "__last_assistant__" ? "[last]" : turn.reason ? "[likely]" : "[recent]";
  const evidence = turn.evidenceExcerpt ? ` · ev: ${bounded(turn.evidenceExcerpt, 48)}` : "";
  return `${prefix} ${turn.role} · ${reasonCategory(turn)} · ${bounded(turn.excerpt, 96)}${evidence}`;
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
    return { ...pickable, label: formatTurnLabel(pickable) } satisfies PickableTurn;
  });

  const lastAssistant = [...turns].reverse().find((turn) => turn.role === "assistant");
  const fastPath = lastAssistant
    ? [{ ...lastAssistant, id: "__last_assistant__", sourceTurnId: lastAssistant.id, score: lastAssistant.score + 10_000, reason: undefined, label: formatTurnLabel({ ...lastAssistant, id: "__last_assistant__", sourceTurnId: lastAssistant.id, score: lastAssistant.score + 10_000, reason: undefined }) }]
    : [];

  const ranked = [...turns].sort((a, b) => b.score - a.score).slice(0, limit);
  return [...ranked, ...fastPath];
}

function renderReview(record: LearningRecord): string {
  return [
    `created: ${record.id}`,
    `source: ${record.source.role} turn ${record.source.turnId ?? "unknown"}`,
    `issue: ${record.issue.description}`,
    record.issue.desiredFutureBehavior ? `future: ${record.issue.desiredFutureBehavior}` : undefined,
    "",
    "review:",
    `target: ${record.recommendedTarget.kind}:${record.recommendedTarget.path}`,
    `classification: ${record.classification}`,
    `rule: ${record.draft?.proposedText ?? "(none)"}`,
    `rationale: ${record.draft?.rationale ?? "(none)"}`,
    "",
    `approve with: /learn approve ${record.id}`,
    `reject with: /learn reject ${record.id} <reason>`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderFullDraft(record: LearningRecord): string {
  return [
    `# ${record.id}`,
    `status: ${record.status}`,
    `classification: ${record.classification}`,
    `target: ${record.recommendedTarget.kind}:${record.recommendedTarget.path}`,
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
    `approve: /learn approve ${record.id}`,
    `reject: /learn reject ${record.id} <reason>`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatDraftLabel(record: LearningRecord): string {
  const rule = record.draft?.proposedText || "(no draft yet)";
  return `${record.id} · ${record.classification} · ${bounded(rule, 180).replace(/\s+/g, " ")} · ${bounded(record.issue.description, 120).replace(/\s+/g, " ")}`;
}

export async function runDraftReview(root: string, ctx: ExtensionCommandContext): Promise<{ ok: true; message: string; record: LearningRecord } | { ok: false; message: string }> {
  if (!ctx.hasUI) return { ok: false, message: "UI draft review unavailable in this mode. Use: /learn pending, /learn show <id>, /learn approve <id>, or /learn reject <id>." };
  const pending = listLearnings(root);
  const drafts = pending.filter((record) => record.draft);
  if (pending.length === 0) return { ok: false, message: "No pending learnings. Use /learn pick or /learn note <issue> first." };
  if (drafts.length === 0) return { ok: false, message: `Found ${pending.length} pending learning${pending.length === 1 ? "" : "s"} without drafts. Use /learn draft <id> first.` };

  const labels = drafts.map(formatDraftLabel);
  const pickedLabel = await ctx.ui.select("Select draft to review", labels);
  if (!pickedLabel) return { ok: false, message: "Cancelled. No draft selected." };
  const record = drafts[labels.indexOf(pickedLabel)];
  if (!record) return { ok: false, message: "Cancelled. Selected draft was not found." };

  await ctx.ui.editor("Review learning draft (full text)", renderFullDraft(record));
  const applyLabel = "Apply rule to AGENTS.md";
  const backLabel = "Keep pending / Back";
  const rejectLabel = "Reject draft";
  const action = await ctx.ui.select("Apply or reject this draft", [backLabel, applyLabel, rejectLabel]);
  if (action === applyLabel) {
    const target = `${record.recommendedTarget.kind}:${record.recommendedTarget.path}`;
    const rule = record.draft?.proposedText ?? "(none)";
    const consequence = `Target: ${target}\nRule to append: ${rule}`;
    const ui = ctx.ui as typeof ctx.ui & { confirm?: (title: string, message: string) => Promise<boolean> };
    const confirmed = ui.confirm
      ? await ui.confirm("Confirm applying rule to AGENTS.md", consequence)
      : (await ctx.ui.select(`Confirm applying rule to AGENTS.md\n\n${consequence}`, [backLabel, applyLabel])) === applyLabel;
    if (!confirmed) return { ok: false, message: "Cancelled. Draft left pending." };
    const result = applyRepoAgentsRule(root, record);
    if (result.applied) {
      record.appliedAt = new Date().toISOString();
      moveLearning(root, record, "applied");
    }
    return { ok: true, record, message: result.message };
  }
  if (action === rejectLabel) {
    const reasons = ["Duplicate / already covered", "Too specific / not durable", "Wrong target", "Bad draft wording", "Not actually a mistake", "Other..."];
    const structuredReason = await ctx.ui.select("Reject reason", reasons);
    if (!structuredReason) return { ok: false, message: "Cancelled. Draft left pending." };
    const detail = (await ctx.ui.input("Optional rejection detail", "Optional detail"))?.trim();
    record.rejectionReason = detail ? `${structuredReason} — ${detail}` : structuredReason;
    moveLearning(root, record, "rejected");
    return { ok: true, record, message: `rejected: ${record.id}` };
  }
  return { ok: false, message: "Cancelled. Draft left pending." };
}

export async function runInteractiveLearn(root: string, ctx: ExtensionCommandContext): Promise<{ ok: true; record: LearningRecord; message: string } | { ok: false; message: string }> {
  if (!ctx.hasUI) {
    return { ok: false, message: "UI picker unavailable in this mode. Use: /learn note <what went wrong>" };
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

    await ctx.ui.editor("Selected turn preview", renderTurnPreview(candidate));
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
