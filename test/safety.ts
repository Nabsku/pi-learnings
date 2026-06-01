import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";
import { createLearning } from "../src/store.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Command = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };
const commands: Record<string, Command> = {};
const messages: Array<{ content: string; details?: unknown }> = [];
learningLoop({
  on() {},
  registerTool() {},
  registerCommand(name: string, command: Command) { commands[name] = command; },
  sendMessage(message: { content: string; details?: unknown }) { messages.push(message); },
} as never);

const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-safety-"));
mkdirSync(join(root, ".pi"), { recursive: true });
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, ".pi", "learning-loop.json"), JSON.stringify({ version: 1, repoAgentsPath: "docs/TEAM_RULES.md" }), "utf8");
writeFileSync(join(root, "AGENTS.md"), "# Wrong target\n", "utf8");
writeFileSync(join(root, "docs/TEAM_RULES.md"), "# Team Rules\n", "utf8");

await commands.learn.handler("note claimed tests passed without running them", { cwd: root });
const noteMessage = messages.at(-1)?.content ?? "";
assert(noteMessage.includes("captured:"), "note success should include the captured learning id");
assert(noteMessage.includes("no repo rule applied"), "note success should explicitly say no repo rule was applied");
assert(noteMessage.includes("next: /learn"), "note success should point to /learn review");
assert(!noteMessage.includes("docs/TEAM_RULES.md"), "non-UI note success should stay concise and omit target details");
const id = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(noteMessage)?.[0];
assert(id, "note message should include id");
const beforeTarget = readFileSync(join(root, "docs/TEAM_RULES.md"), "utf8");

await commands.learn.handler(`approve ${id}`, { cwd: root });
const unconfirmed = messages.at(-1)?.content ?? "";
assert(unconfirmed.includes("--confirm"), "direct approve without --confirm should require explicit confirmation");
assert(unconfirmed.toLowerCase().includes("preview") || unconfirmed.toLowerCase().includes("would apply"), "direct approve without --confirm should return a preview/would-apply message");
assert(readFileSync(join(root, "docs/TEAM_RULES.md"), "utf8") === beforeTarget, "direct approve without --confirm must not write target file");
assert(existsSync(join(root, ".pi/learnings/pending", `${id}.json`)), "unconfirmed approve must leave record pending");

await commands.learn.handler(`approve ${id} confirm`, { cwd: root });
assert(readFileSync(join(root, "docs/TEAM_RULES.md"), "utf8") === beforeTarget, "bare confirm must not write target file; require exact --confirm flag");

await commands.learn.handler(`approve ${id} garbage --confirm`, { cwd: root });
assert(readFileSync(join(root, "docs/TEAM_RULES.md"), "utf8") === beforeTarget, "--confirm must be the only approval argument after the id");

await commands.learn.handler(`approve ${id} --confirm`, { cwd: root });
const confirmed = messages.at(-1)?.content ?? "";
assert(confirmed.includes("docs/TEAM_RULES.md"), "confirmed approve should report the actual configured target path");
assert(readFileSync(join(root, "docs/TEAM_RULES.md"), "utf8").includes("Do not claim a check passed"), "confirmed approve should write configured repoAgentsPath");
assert(!readFileSync(join(root, "AGENTS.md"), "utf8").includes("Do not claim a check passed"), "confirmed approve must not write hardcoded AGENTS.md when repoAgentsPath differs");

const pickRoot = mkdtempSync(join(tmpdir(), "pi-learning-loop-safety-pick-"));
writeFileSync(join(pickRoot, "AGENTS.md"), "# Repo Rules\n", "utf8");
await commands.learn.handler("pick", {
  cwd: pickRoot,
  hasUI: true,
  sessionManager: { getEntries: () => [{ id: "a1", type: "message", timestamp: "2026-06-01T00:00:00.000Z", message: { role: "assistant", content: "I verified it works." } }] },
  ui: {
    async select(title: string, options: string[]) { return title === "Use this turn?" ? "Use this turn" : options[0]; },
    async input() { return "Claimed verification without evidence."; },
    async editor(title: string, prefill: string) { return title === "What should Pi do differently next time?" ? "Only claim verification after running the check." : prefill; },
  },
} as never);
const pickMessage = messages.at(-1)?.content ?? "";
assert(pickMessage.includes("pending learning") || pickMessage.includes("proposed rule"), "pick success should say it created a pending learning/proposed rule");
assert(pickMessage.includes("no repo rule applied yet"), "pick success should explicitly say no repo rule was applied yet");
assert(pickMessage.includes("/learn review"), "pick success should point to /learn review");
assert(pickMessage.includes("AGENTS.md"), "pick success should include target if approved");

const maliciousRoot = mkdtempSync(join(tmpdir(), "pi-learning-loop-malicious-"));
writeFileSync(join(maliciousRoot, "AGENTS.md"), "# Repo Rules\n", "utf8");
const outside = join(tmpdir(), `pi-learning-loop-outside-${process.pid}.md`);
writeFileSync(outside, "outside\n", "utf8");
const malicious = createLearning(maliciousRoot, {
  source: { selector: "manual", role: "unknown", excerpt: "bad persisted path" },
  issue: { description: "bad persisted path" },
  classification: "other",
  recommendedTarget: { kind: "repo-agents", path: outside },
});
malicious.draft = { section: "Agent Learnings", proposedText: "- Never write outside repo.", rationale: "safety", risk: "medium", duplicateCheck: { searched: [], similarExistingRule: null } };
writeFileSync(join(maliciousRoot, ".pi/learnings/pending", `${malicious.id}.json`), JSON.stringify(malicious, null, 2), "utf8");
await commands.learn.handler(`approve ${malicious.id} --confirm`, { cwd: maliciousRoot });
assert((messages.at(-1)?.content ?? "").includes("unsafe") || (messages.at(-1)?.content ?? "").includes("rejected"), "escaped persisted target should be rejected before write");
assert(readFileSync(outside, "utf8") === "outside\n", "escaped persisted target must not be written");

console.log(`safety root=${root} id=${id}`);
