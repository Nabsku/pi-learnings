import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyLearningRule, previewLearningRule } from "./apply.ts";
import { draftLearning } from "./draft.ts";
import { runDraftReview, runInteractiveLearn, runLearningMainMenu, runQuickNote } from "./interactive.ts";
import { listLearnings, moveLearning, readLearning, repoRoot, saveLearning } from "./store.ts";
import type { LearningClassification, LearningRecord } from "./types.ts";

const CLASSIFICATION_LABELS: Record<LearningClassification, string> = {
  verification_overclaim: "Verification overclaim",
  scope_drift: "Scope drift",
  unsafe_edit: "Unsafe edit",
  wrong_tool: "Wrong tool",
  context_miss: "Context miss",
  stale_data: "Stale data",
  transient: "Transient / note only",
  other: "Other",
};

const PRIMARY_HELP = [
  "Primary:",
  "/learn",
  "/learn note <issue>",
].join("\n");

const ADVANCED_HELP = [
  "Advanced fallback:",
  "/learn review",
  "/learn pending",
  "/learn show <id>",
  "/learn draft <id>",
  "/learn approve <id> --confirm | --confirm-global",
  "/learn reject <id> [reason]",
].join("\n");

const LEARN_HELP = `${PRIMARY_HELP}\n\n${ADVANCED_HELP}\n\nUse /learn to review pending drafts in the UI. Use /learn note <issue> to capture a concrete mistake; it creates a pending draft without applying repo rules. Advanced commands are CLI fallbacks; direct approve without --confirm previews only.`;

function classificationLabel(classification: LearningClassification): string {
  return CLASSIFICATION_LABELS[classification] ?? classification;
}

function shortLine(text: string, max = 110): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function renderPendingSummary(records: LearningRecord[]): string {
  if (!records.length) return "No pending learnings.";
  const noun = records.length === 1 ? "learning" : "learnings";
  return [
    `${records.length} pending ${noun}:`,
    ...records.map((record) => `- ${record.id} · ${classificationLabel(record.classification)} · ${record.recommendedTarget.kind}:${record.recommendedTarget.path} · ${shortLine(record.issue.description)}`),
    "",
    "Next: /learn or /learn show <id>",
  ].join("\n");
}

function statusNextAction(record: LearningRecord): string[] {
  if (record.status !== "pending") return [`next: no approval action; learning is ${record.status}.`];
  return [
    "next: /learn",
    `CLI approve: /learn approve ${record.id} --confirm`,
    `reject: /learn reject ${record.id} Keep as note only / do not apply rule`,
  ];
}

function renderRecord(record: ReturnType<typeof readLearning>): string {
  const lines = [
    `# ${record.id}`,
    `status: ${record.status}`,
    `classification: ${classificationLabel(record.classification)}`,
    `target: ${record.recommendedTarget.kind}:${record.recommendedTarget.path}`,
    `issue: ${record.issue.description}`,
  ];
  if (record.draft) lines.push("", `section: ${record.draft.section}`, `rule: ${record.draft.proposedText || "(note-only)"}`, `rationale: ${record.draft.rationale}`, `duplicate: ${record.draft.duplicateCheck.similarExistingRule ?? "none"}`);
  lines.push("", ...statusNextAction(record));
  return lines.join("\n");
}

export function registerLearningCommand(pi: ExtensionAPI) {
  pi.registerCommand("learn", {
    description: "Pi learnings:\n/learn\n/learn note <issue>",
    getArgumentCompletions(prefix: string, ctx?: { cwd?: unknown }) {
      const trimmedStart = prefix.trimStart();
      const parts = trimmedStart.split(/\s+/);
      if (/\s/.test(trimmedStart)) {
        const sub = parts[0];
        if (sub === "note") return null;
        if (!["show", "draft", "approve", "reject"].includes(sub)) return null;
        const idPrefix = parts[1] ?? "";
        try {
          const root = repoRoot(typeof ctx?.cwd === "string" ? ctx.cwd : undefined);
          return listLearnings(root).filter((record) => record.id.startsWith(idPrefix)).map((record) => ({ value: record.id, label: record.id }));
        } catch {
          return [];
        }
      }
      const first = trimmedStart;
      if (first === "") return [{ value: "", label: "/learn" }, { value: "note", label: "note <issue>" }];
      return ["pick", "last", "review", "note", "pending", "show", "draft", "approve", "reject", "help"].filter((value) => value.startsWith(first)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const [subRaw, ...rest] = args.trim().split(/\s/).filter(Boolean);
      const sub = subRaw ?? "menu";
      const root = repoRoot(ctx.cwd);
      const send = (content: string, details?: unknown) => pi.sendMessage({ customType: "pi-learnings", display: true, content, details });

      if (sub === "menu") {
        const result = await runLearningMainMenu(root, ctx);
        send(result.message, result.ok ? result.record : result);
        return;
      }
      if (sub === "help") {
        send(LEARN_HELP);
        return;
      }
      if (sub === "pick" || sub === "last") {
        const result = await runInteractiveLearn(root, ctx);
        send(result.message, result.ok ? result.record : result);
        return;
      }
      if (sub === "review" || sub === "drafts") {
        const result = await runDraftReview(root, ctx);
        send(result.message, result.ok ? result.record : result);
        return;
      }
      if (sub === "note") {
        const issue = rest.join(" ").trim();
        if (!issue) { send("usage: /learn note <what went wrong>"); return; }
        const result = await runQuickNote(root, ctx, issue);
        if (result.ok && ctx.hasUI) {
          const action = await ctx.ui.select("Review this learning draft now?", ["Review now", "Keep pending"]);
          if (action === "Review now") {
            const reviewResult = await runDraftReview(root, ctx);
            send(reviewResult.message, reviewResult.ok ? reviewResult.record : reviewResult);
            return;
          }
        }
        send(result.message, result.ok ? result.record : result);
        return;
      }
      if (sub === "pending") {
        const records = listLearnings(root);
        send(renderPendingSummary(records), { records });
        return;
      }
      if (sub === "show") {
        const id = rest[0];
        if (!id) { send("usage: /learn show <id>"); return; }
        const record = readLearning(root, id);
        send(renderRecord(record), record);
        return;
      }
      if (sub === "draft") {
        const id = rest[0];
        if (!id) { send("usage: /learn draft <id>"); return; }
        const record = readLearning(root, id);
        record.draft = await draftLearning(root, record, ctx);
        saveLearning(root, record);
        send(`${renderRecord(record)}\n\nApprove with: /learn approve ${record.id} --confirm`, record);
        return;
      }
      if (sub === "approve") {
        const id = rest[0];
        if (!id) { send("usage: /learn approve <id> --confirm | --confirm-global"); return; }
        const record = readLearning(root, id);
        const flags = rest.slice(1);
        const confirmedRepo = flags[0] === "--confirm" && flags.slice(1).every((flag) => flag === "--update" || flag === "--append");
        const confirmedGlobal = flags[0] === "--confirm-global" && flags.slice(1).every((flag) => flag === "--update" || flag === "--append");
        const wantsUpdate = flags.includes("--update");
        const wantsAppend = flags.includes("--append");
        const result = (confirmedRepo || confirmedGlobal)
          ? applyLearningRule(root, record, { allowGlobal: confirmedGlobal, mode: wantsUpdate ? "update" : wantsAppend ? "append" : undefined })
          : previewLearningRule(root, record);
        if (result.applied) {
          record.appliedAt = new Date().toISOString();
          moveLearning(root, record, "applied");
        }
        send(result.message, result);
        return;
      }
      if (sub === "reject") {
        const id = rest[0];
        if (!id) { send("usage: /learn reject <id> [reason]"); return; }
        const record = readLearning(root, id);
        record.rejectionReason = rest.slice(1).join(" ").trim() || undefined;
        moveLearning(root, record, "rejected");
        send(`rejected: ${id}`, record);
        return;
      }
      send(LEARN_HELP);
    },
  });
}
