import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";

type Completion = { value: string; label?: string };
type Command = {
  description?: string;
  handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
  getArgumentCompletions?: (prefix: string, ctx?: Record<string, unknown>) => Completion[] | null;
};

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

const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-ux-"));
writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");

assert(commands.learn.description?.includes("/learn\n/learn note <issue>"), "primary command description should only promote /learn and /learn note <issue>");
assert(!commands.learn.description?.includes("approve <id>"), "primary command description should not promote direct approve");

await commands.learn.handler("help", { cwd: root });
const help = messages.at(-1)?.content ?? "";
assert(help.includes("Primary:"), "help should include a primary section");
assert(help.includes("/learn\n/learn note <issue>"), "primary help should show only /learn and /learn note <issue>");
assert(help.includes("Advanced fallback:"), "help should include advanced fallback section");
for (const command of ["review", "pending", "show", "draft", "approve", "reject"]) {
  assert(help.includes(`/learn ${command}`), `advanced fallback should list ${command}`);
}

await commands.learn.handler("note Pi claimed tests passed without running the command", { cwd: root });
const id = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(messages.at(-1)?.content ?? "")?.[0];
assert(id, "note should create a learning id");

await commands.learn.handler("pending", { cwd: root });
const pending = messages.at(-1)?.content ?? "";
assert(pending.includes("1 pending learning"), "pending should show count");
assert(pending.includes(id), "pending should show id");
assert(pending.includes("Verification overclaim"), "pending should use human classification label");
assert(pending.includes("repo-agents:AGENTS.md"), "pending should show target");
assert(pending.includes("Pi claimed tests passed"), "pending should show short issue");
assert(pending.includes(`/learn`) && pending.includes(`/learn show <id>`), "pending should show next menu/show actions");
assert(!pending.includes("rationale:"), "pending should not dump full draft rationale");
assert(!pending.includes("rule:"), "pending should not dump full draft rule");

await commands.learn.handler(`show ${id}`, { cwd: root });
const shown = messages.at(-1)?.content ?? "";
assert(shown.includes("classification: Verification overclaim"), "show should use human classification label");
assert(shown.includes(`next: /learn`), "pending show should suggest UI review");
assert(shown.includes(`CLI approve: /learn approve ${id} --confirm`), "pending show should include safe CLI approve fallback");
assert(shown.includes(`reject: /learn reject ${id} Keep as note only / do not apply rule`), "pending show should include structured rejection command");

const complete = commands.learn.getArgumentCompletions;
assert(complete, "learn command should expose completions");
const topLevel = complete("", { cwd: root }) ?? [];
assert(topLevel.some((item) => item.value === ""), "top-level completions should include bare /learn");
assert(topLevel.some((item) => item.value === "note"), "top-level completions should include primary note command");
for (const command of ["show", "draft", "approve", "reject"]) {
  assert(!topLevel.some((item) => item.value === command), `top-level completions should not promote ${command}`);
}
assert(complete("show ", { cwd: root })?.some((item) => item.value === id), "show should complete pending ids after subcommand");
assert(complete("draft ", { cwd: root })?.some((item) => item.value === id), "draft should complete pending ids after subcommand");
assert(complete("approve ", { cwd: root })?.some((item) => item.value === id), "approve should complete pending ids after subcommand");
assert(complete("reject ", { cwd: root })?.some((item) => item.value === id), "reject should complete pending ids after subcommand");
assert(complete("app", { cwd: root })?.some((item) => item.value === "approve"), "advanced approve command should remain available when explicitly typed");
assert(complete("note anything", { cwd: root }) === null, "note free-form autocomplete should be disabled");

await commands.learn.handler(`reject ${id} Keep as note only / do not apply rule`, { cwd: root });
assert(existsSync(join(root, ".pi/learnings/rejected", `${id}.json`)), "reject should move record");
const rejectedRecord = JSON.parse(readFileSync(join(root, ".pi/learnings/rejected", `${id}.json`), "utf8"));
assert(rejectedRecord.rejectionReason === "Keep as note only / do not apply rule", "reject should store structured note-only reason");

await commands.learn.handler(`show ${id}`, { cwd: root });
const rejectedShow = messages.at(-1)?.content ?? "";
assert(rejectedShow.includes("status: rejected"), "show should find rejected records");
assert(!rejectedShow.includes("approve"), "rejected show should not show approve command");

await commands.learn.handler("pick", { cwd: root, hasUI: false });
assert((messages.at(-1)?.content ?? "").includes("No learning was created"), "no-UI pick fallback should say no learning was created");
await commands.learn.handler("review", { cwd: root, hasUI: false });
assert((messages.at(-1)?.content ?? "").includes("No learning was lost"), "no-UI review fallback should say no learning was lost");

console.log(`ux-polish root=${root} id=${id}`);
