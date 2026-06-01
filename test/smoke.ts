import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
type Command = { handler: (args: string, ctx: { cwd: string }) => Promise<void> };

const tools: Tool[] = [];
const commands: Record<string, Command> = {};
const messages: Array<{ content: string; details?: unknown }> = [];

learningLoop({
  on() {},
  registerTool(tool: Tool) { tools.push(tool); },
  registerCommand(name: string, command: Command) { commands[name] = command; },
  sendMessage(message: { content: string; details?: unknown }) { messages.push(message); },
} as never);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-"));
writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n\n## Verification\n\n", "utf8");

await commands.learn.handler("note Pi claimed tests passed without running the command", { cwd: root });
assert(messages.at(-1)?.content.includes("captured: learn_"), "note should create and draft a learning");
const id = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(messages.at(-1)?.content ?? "")?.[0];
assert(id, "created message should include id");
assert(existsSync(join(root, ".pi/learnings/pending", `${id}.json`)), "pending record should be written");

await commands.learn.handler(`draft ${id}`, { cwd: root });
assert(messages.at(-1)?.content.includes("Do not claim a check passed"), "draft should propose verification rule");
assert(!readFileSync(join(root, "AGENTS.md"), "utf8").includes("Do not claim a check passed"), "draft must not write AGENTS");

await commands.learn.handler(`approve ${id} --confirm`, { cwd: root });
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
assert(agents.includes("## Agent Learnings"), "approval should add Agent Learnings section");
assert(agents.includes("Do not claim a check passed"), "approval should apply rule");
assert(existsSync(join(root, ".pi/learnings/applied", `${id}.json`)), "applied record should be moved");

const listTool = tools.find((tool) => tool.name === "learning_list");
assert(listTool, "learning_list tool should register");
const result = await listTool.execute("list", { cwd: root }) as { content: Array<{ text: string }> };
assert(result.content[0]?.text.includes("No pending learnings"), "list tool should report no pending learnings");

console.log(`smoke root=${root} id=${id}`);
