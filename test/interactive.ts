import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";

type Command = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };

const commands: Record<string, Command> = {};
const messages: Array<{ content: string; details?: unknown }> = [];

learningLoop({
  on() {},
  registerTool() {},
  registerCommand(name: string, command: Command) { commands[name] = command; },
  sendMessage(message: { content: string; details?: unknown }) { messages.push(message); },
} as never);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-ui-"));
writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");

const uiCalls: string[] = [];
let selectCount = 0;
let sawPreview = false;
const ctx = {
  cwd: root,
  hasUI: true,
  sessionManager: {
    getEntries() {
      return [
        {
          id: "u1",
          type: "message",
          timestamp: "2026-05-31T10:00:00.000Z",
          message: { role: "user", content: "Please fix the tests." },
        },
        {
          id: "t1",
          type: "message",
          timestamp: "2026-05-31T10:01:00.000Z",
          message: { role: "tool", content: "pnpm test failed with exit code 1" },
        },
        {
          id: "a1",
          type: "message",
          timestamp: "2026-05-31T10:02:00.000Z",
          message: { role: "assistant", content: "All tests pass now." },
        },
      ];
    },
  },
  ui: {
    async select(title: string, options: string[]) {
      selectCount += 1;
      uiCalls.push(`select:${title}:${options.join("|")}`);
      if (selectCount === 1) {
        assert(title === "Select the turn to learn from", "picker title should use the new concise copy");
        const assistantOption = options.find((option) => option.includes("assistant") && option.includes("All tests pass"));
        assert(assistantOption, "picker should include assistant turn excerpts");
        assert(/^\[(likely|recent|last)\] (assistant|tool|user) · /.test(assistantOption) && assistantOption.split(" · ").length >= 3, `picker label should use stable category/role/reason/excerpt columns: ${assistantOption}`);
        assert(!assistantOption.includes("after tool failure"), "picker label should avoid dense prose reasons");
        return assistantOption;
      }
      assert(title === "Use this turn?", "preview confirmation should be asked after full preview");
      assert(options.join("|") === "Use this turn|Back to picker|Cancel", "preview confirmation should offer use/back/cancel");
      return "Use this turn";
    },
    async input(title: string, placeholder?: string) {
      uiCalls.push(`input:${title}:${placeholder ?? ""}`);
      assert(title.includes("What went wrong"), "issue prompt should be explicit");
      assert(placeholder === "Claimed success after tool output showed failure.", "issue prompt should suggest an issue from reason/evidence");
      return placeholder;
    },
    async editor(title: string, prefill?: string) {
      uiCalls.push(`editor:${title}:${prefill ?? ""}`);
      if (title === "Selected turn preview") {
        sawPreview = true;
        assert(prefill?.includes("selected excerpt:"), "preview should include selected excerpt heading");
        assert(prefill?.includes("All tests pass now."), "preview should include selected excerpt text");
        assert(prefill?.includes("evidence excerpt:"), "preview should include evidence heading when present");
        assert(prefill?.includes("pnpm test failed with exit code 1"), "preview should include evidence excerpt text");
        return prefill;
      }
      assert(title === "What should Pi do differently next time?", "desired behavior editor should use new copy");
      return "Never claim tests passed unless the latest actual test command exited 0.";
    },
  },
};

await commands.learn.handler("pick", ctx);

assert(uiCalls.length === 5, "interactive picker should use picker select, preview editor/select, issue input, and behavior editor only");
assert(sawPreview, "interactive picker should preview the selected turn before asking for issue");
const content = messages.at(-1)?.content ?? "";
assert(content.includes("created:"), "pick should create a learning record");
assert(content.includes("review:"), "pick should show a review summary");
assert(content.includes("approve with: /learn approve"), "pick should leave approval explicit");
const id = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(content)?.[0];
assert(id, "created message should include id");
assert(existsSync(join(root, ".pi/learnings/pending", `${id}.json`)), "pick should write pending record only");
const record = JSON.parse(readFileSync(join(root, ".pi/learnings/pending", `${id}.json`), "utf8"));
assert(record.source.selector === "turn-id", "record should preserve selected turn id source");
assert(record.source.turnId === "a1", "record should preserve selected entry id");
assert(record.issue.desiredFutureBehavior?.includes("Never claim tests passed"), "desired future behavior should be saved");
assert(record.draft?.proposedText, "pick should draft a reviewable rule");
assert(!readFileSync(join(root, "AGENTS.md"), "utf8").includes(record.draft.proposedText), "pick must not write AGENTS.md");

await commands.learn.handler("pick", { cwd: root, hasUI: false });
assert(messages.at(-1)?.content.includes("UI picker unavailable"), "non-UI mode should fall back without throwing");

console.log(`interactive root=${root} id=${id}`);
