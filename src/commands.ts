import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyRepoAgentsRule } from "./apply.ts";
import { classifyIssueWithModel, draftLearning, recommendTarget } from "./draft.ts";
import { runDraftReview, runInteractiveLearn } from "./interactive.ts";
import { bounded, createLearning, listLearnings, moveLearning, readLearning, repoRoot, saveLearning } from "./store.ts";
import { loadConfig } from "./config.ts";

function renderRecord(record: ReturnType<typeof readLearning>): string {
  const lines = [
    `# ${record.id}`,
    `status: ${record.status}`,
    `classification: ${record.classification}`,
    `target: ${record.recommendedTarget.kind}:${record.recommendedTarget.path}`,
    `issue: ${record.issue.description}`,
  ];
  if (record.draft) lines.push("", `section: ${record.draft.section}`, `rule: ${record.draft.proposedText || "(note-only)"}`, `rationale: ${record.draft.rationale}`, `duplicate: ${record.draft.duplicateCheck.similarExistingRule ?? "none"}`);
  return lines.join("\n");
}

export function registerLearningCommand(pi: ExtensionAPI) {
  pi.registerCommand("learn", {
    description: "Learning loop: pick | review | note <issue> | draft <id> | show <id> | pending | approve <id> | reject <id> [reason]",
    getArgumentCompletions(prefix) {
      const trimmedStart = prefix.trimStart();
      if (/\s/.test(trimmedStart)) return null;
      const first = trimmedStart;
      return ["pick", "review", "note", "draft", "show", "pending", "approve", "reject", "help"].filter((value) => value.startsWith(first)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const [subRaw, ...rest] = args.trim().split(/\s/).filter(Boolean);
      const sub = subRaw ?? "help";
      const root = repoRoot(ctx.cwd);
      const config = loadConfig(root);
      const send = (content: string, details?: unknown) => pi.sendMessage({ customType: "learning-loop", display: true, content, details });

      if (sub === "help") {
        send("usage: /learn pick | review | note <issue> | draft <id> | show <id> | pending | approve <id> | reject <id> [reason]\n\nUse /learn pick to create a draft from a bad turn. Use /learn review to pick, inspect, approve, or reject pending drafts.");
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
        const classification = await classifyIssueWithModel(root, issue, ctx);
        const target = recommendTarget(classification);
        if (target.kind === "repo-agents") target.path = config.repoAgentsPath;
        const record = createLearning(root, { source: { selector: "manual", role: "unknown", excerpt: bounded(issue, config.maxExcerptChars) }, issue: { description: bounded(issue, 1000) }, classification, recommendedTarget: target });
        record.draft = await draftLearning(root, record, ctx);
        saveLearning(root, record);
        send(`drafted: ${record.id}\nReview with: /learn review`, record);
        return;
      }
      if (sub === "pending") {
        const records = listLearnings(root);
        send(records.length ? records.map(renderRecord).join("\n\n") : "No pending learnings.", { records });
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
        send(`${renderRecord(record)}\n\nApprove with: /learn approve ${record.id}`, record);
        return;
      }
      if (sub === "approve") {
        const id = rest[0];
        if (!id) { send("usage: /learn approve <id>"); return; }
        const record = readLearning(root, id);
        const result = applyRepoAgentsRule(root, record);
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
      send("usage: /learn pick | review | note <issue> | draft <id> | show <id> | pending | approve <id> | reject <id> [reason]");
    },
  });
}
