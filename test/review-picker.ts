import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";
import { createLearning } from "../src/store.ts";

type Command = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };

const commands: Record<string, Command> = {};
const messages: Array<{ content: string; details?: unknown }> = [];
const uiCalls: string[] = [];
const rejectMessages: Array<{ content: string; details?: unknown }> = [];

learningLoop({
  on() {},
  registerTool() {},
  registerCommand(name: string, command: Command) { commands[name] = command; },
  sendMessage(message: { content: string; details?: unknown }) { messages.push(message); },
} as never);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-review-"));
writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");
const longIssue = `claimed tests passed without running them ${"with lots of surrounding context ".repeat(20)}`;

await commands.learn.handler(`note ${longIssue}`, { cwd: root });
const id = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(messages.at(-1)?.content ?? "")?.[0];
assert(id, "created message should include id");
await commands.learn.handler(`draft ${id}`, { cwd: root });

const ctx = {
  cwd: root,
  hasUI: true,
  ui: {
    async select(title: string, options: string[]) {
      uiCalls.push(`select:${title}:${options.join("|")}`);
      if (title.includes("Select draft")) {
        assert(options.some((option) => option.includes(id)), "draft picker should show pending draft id");
        assert(options.some((option) => option.includes("Do not claim a check passed")), "draft picker should show rule preview");
        return options.find((option) => option.includes(id));
      }
      if (title.includes("Apply or reject")) {
        assert(options[0] === "Keep pending / Back", "safe/back action should be first");
        assert(options.includes("Apply rule to AGENTS.md"), "apply action should be explicit about AGENTS.md");
        assert(options.includes("Reject draft"), "reject action should be explicit");
        return "Apply rule to AGENTS.md";
      }
      if (title.includes("Confirm applying")) {
        assert(title.includes("Will edit: AGENTS.md"), "confirmation should show exact file edit behavior");
        assert(title.includes("Section: ## Agent Learnings"), "confirmation should show target section");
        assert(title.includes("Change: append single bullet if not already present"), "confirmation should show exact change behavior");
        assert(options[0] === "Keep pending / Back", "confirmation safe/back choice should be first");
        assert(options.includes("Apply rule to AGENTS.md"), "confirmation should require explicit apply");
        return "Apply rule to AGENTS.md";
      }
      throw new Error(`unexpected select title: ${title}`);
    },
    async editor(title: string, prefill: string) {
      uiCalls.push(`editor:${title}:${prefill.length}`);
      assert(title === "Read-only preview: learning draft", "review picker should show a read-only draft preview");
      assert(prefill.includes("source excerpt:"), "full draft view should include source excerpt");
      assert(prefill.includes("Do not claim a check passed"), "full draft view should include proposed rule");
      assert(prefill.includes("lots of surrounding context"), "full draft view should preserve long context instead of select-label truncation");
      assert(prefill.includes("risk:"), "full draft view should include risk");
      assert(prefill.includes("duplicate:"), "full draft view should include duplicate check");
      assert(prefill.includes("searched paths:"), "full draft view should include searched paths");
      return prefill;
    },
  },
};

await commands.learn.handler("review", ctx);
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
assert(agents.includes("Do not claim a check passed"), "approving through review picker should apply draft");
assert(existsSync(join(root, ".pi/learnings/applied", `${id}.json`)), "review-approved draft should move to applied");
assert(uiCalls.some((call) => call.startsWith("select:Select draft")), "draft picker should be used");
assert(uiCalls.some((call) => call.startsWith("editor:Read-only preview: learning draft")), "full overflow review should be used");

const followUpRoot = mkdtempSync(join(tmpdir(), "pi-learning-loop-note-follow-up-"));
writeFileSync(join(followUpRoot, "AGENTS.md"), "# Repo Rules\n", "utf8");
let followUpId = "";
const followUpSelects: string[] = [];
await commands.learn.handler("note claimed tests passed after a failing command", {
  cwd: followUpRoot,
  hasUI: true,
  ui: {
    async select(title: string, options: string[]) {
      followUpSelects.push(`${title}:${options.join("|")}`);
      if (title === "Review this learning draft now?") {
        assert(options[0] === "Review now", "note follow-up should offer Review now first");
        assert(options[1] === "Keep pending", "note follow-up should offer Keep pending");
        return "Review now";
      }
      if (title.includes("Select draft")) {
        followUpId = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(options[0] ?? "")?.[0] ?? "";
        assert(followUpId, "review-now draft picker should include the newly captured draft");
        return options[0];
      }
      if (title.includes("Apply or reject")) return "Keep pending / Back";
      throw new Error(`unexpected follow-up select title: ${title}`);
    },
    async editor(_title: string, prefill: string) { return prefill; },
  },
} as never);
assert(followUpId, "review now should enter draft review flow");
assert(messages.at(-1)?.content.includes("Draft left pending"), "backing out of review-now should keep the draft pending safely");
assert(existsSync(join(followUpRoot, ".pi/learnings/pending", `${followUpId}.json`)), "review-now back action should leave the note pending");
assert(followUpSelects.some((call) => call.startsWith("Review this learning draft now?")), "note should show a follow-up choice when UI is available");

const keepRoot = mkdtempSync(join(tmpdir(), "pi-learning-loop-note-keep-"));
writeFileSync(join(keepRoot, "AGENTS.md"), "# Repo Rules\n", "utf8");
await commands.learn.handler("note keep this draft pending", {
  cwd: keepRoot,
  hasUI: true,
  ui: { async select() { return "Keep pending"; } },
} as never);
const keepMessage = messages.at(-1)?.content ?? "";
assert(keepMessage.includes("captured:"), "Keep pending should send the concise captured message");
assert(keepMessage.includes("no repo rule applied"), "Keep pending should say no repo rule was applied");
assert(keepMessage.includes("next: /learn"), "Keep pending should point to review");

const rejectRoot = mkdtempSync(join(tmpdir(), "pi-learning-loop-review-reject-"));
writeFileSync(join(rejectRoot, "AGENTS.md"), "# Repo Rules\n", "utf8");
await commands.learn.handler("note one-off typo in a temporary scratch file", { cwd: rejectRoot });
const rejectId = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(messages.at(-1)?.content ?? "")?.[0];
assert(rejectId, "created rejection fixture should include id");
await commands.learn.handler(`draft ${rejectId}`, { cwd: rejectRoot });
const rejectCtx = {
  cwd: rejectRoot,
  hasUI: true,
  ui: {
    async select(title: string, options: string[]) {
      if (title.includes("Select draft")) return options.find((option) => option.includes(rejectId));
      if (title.includes("Apply or reject")) return "Reject draft";
      if (title.includes("Reject reason")) {
        assert(options.includes("Duplicate / already covered"), "structured duplicate reason should be offered");
        assert(options.includes("Too specific / not durable"), "structured durability reason should be offered");
        assert(options.includes("Wrong target"), "structured wrong-target reason should be offered");
        assert(options.includes("Bad draft wording"), "structured wording reason should be offered");
        assert(options.includes("Not actually a mistake"), "structured mistake reason should be offered");
        assert(options.includes("Other..."), "structured other reason should be offered");
        return "Too specific / not durable";
      }
      throw new Error(`unexpected reject select title: ${title}`);
    },
    async input(title: string) {
      assert(title.includes("Optional rejection detail"), "rejection should ask for optional detail");
      return "only applied to today's scratch file";
    },
    async editor(_title: string, prefill: string) {
      return prefill;
    },
  },
};
await commands.learn.handler("review", { ...rejectCtx, send: (content: string) => rejectMessages.push({ content }) } as never);
const rejected = JSON.parse(readFileSync(join(rejectRoot, ".pi/learnings/rejected", `${rejectId}.json`), "utf8"));
assert(rejected.rejectionReason === "Too specific / not durable — only applied to today's scratch file", "structured rejection reason and detail should be combined");

const emptyRoot = mkdtempSync(join(tmpdir(), "pi-learning-loop-review-empty-"));
await commands.learn.handler("review", { cwd: emptyRoot, hasUI: true, ui: rejectCtx.ui } as never);
assert(messages.at(-1)?.content.includes("No pending learnings"), "empty state should distinguish no pending learnings");
createLearning(emptyRoot, {
  source: { selector: "manual", role: "unknown", excerpt: "pending without draft" },
  issue: { description: "pending without draft" },
  classification: "other",
  recommendedTarget: { kind: "repo-agents", path: "AGENTS.md" },
});
await commands.learn.handler("review", { cwd: emptyRoot, hasUI: true, ui: rejectCtx.ui } as never);
assert(messages.at(-1)?.content.includes("pending learning") && messages.at(-1)?.content.includes("without drafts"), "empty state should distinguish pending records without drafts");

console.log(`review-picker root=${root} id=${id}`);
