import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";

type Command = { description?: string; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>; handler: (args: string, ctx: { cwd: string }) => Promise<void> };
type Handler = (event: { cwd: string; reason: "startup" | "reload" }, ctx: { cwd: string }) => void | Promise<void>;

const commands: Record<string, Command> = {};
const messages: Array<{ content: string; details?: unknown }> = [];
const handlers: Record<string, Handler[]> = {};

learningLoop({
  on(event: string, handler: Handler) { (handlers[event] ??= []).push(handler); },
  registerTool() {},
  registerCommand(name: string, command: Command) { commands[name] = command; },
  sendMessage(message: { content: string; details?: unknown }) { messages.push(message); },
} as never);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "pi-learnings-config-"));

const configPath = join(root, ".pi/learnings.json");
assert(!commands.learn.description?.includes("init-config"), "help description should not advertise init-config");
assert(!commands.learn.getArgumentCompletions?.("init").some((item) => item.value === "init-config"), "completions should not include init-config");
assert(commands.learn.getArgumentCompletions?.("note test") === null, "completions should not replace note arguments");
await handlers.resources_discover?.[0]?.({ cwd: root, reason: "startup" }, { cwd: root });
assert(existsSync(configPath), "loading the plugin should create .pi/learnings.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
assert(config.learningsDir === ".pi/learnings", "default config should set learningsDir");
assert(config.repoAgentsPath === "AGENTS.md", "default config should set repoAgentsPath");
assert(!config.modelOverrides?.draftRule?.model, "default config should not set draftRule model override");
assert(!config.modelOverrides?.classifyIssue?.model, "default config should not set classifyIssue model override");

writeFileSync(configPath, JSON.stringify({
  version: 1,
  learningsDir: ".pi/custom-learnings",
  repoAgentsPath: "docs/AGENTS.md",
  maxExcerptChars: 12,
  modelOverrides: {
    draftRule: { model: "openai-codex/gpt-5.5", thinkingLevel: "high" },
    classifyIssue: { model: "openai-codex/gpt-5.4-mini", thinkingLevel: "minimal" },
  },
}, null, 2), "utf8");
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs/AGENTS.md"), "# Docs Rules\n", "utf8");

await commands.learn.handler("note tests passed claim used no command", { cwd: root });
const noteMessage = messages.at(-1)?.content ?? "";
const id = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(noteMessage)?.[0];
assert(id, "created message should include id");
assert(noteMessage.includes("captured:"), "note should report the captured learning");
assert(noteMessage.includes("no repo rule applied"), "note should be explicit that no repo rule was applied");
assert(noteMessage.includes("next: /learn"), "note should send the user to the review queue");
assert(existsSync(join(root, ".pi/custom-learnings/pending", `${id}.json`)), "custom learningsDir should be used");
const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
const forbiddenReadmeTerms = ["leg" + "acy", "back" + "wards " + "com" + "pat" + "ibility", "learning" + "-loop.json"];
assert(!forbiddenReadmeTerms.some((term) => readme.toLowerCase().includes(term)), "README should be forward-only and not document old config");
assert(readme.includes('"draftRule"') && readme.includes('"classifyIssue"') && readme.includes('"thinkingLevel"'), "README should show the full modelOverrides config schema");
assert(readme.includes("Example: repo-local rules file") && readme.includes("Example: explicit model overrides"), "README should include config examples");
const noteRecord = JSON.parse(readFileSync(join(root, ".pi/custom-learnings/pending", `${id}.json`), "utf8"));
assert(noteRecord.draft?.proposedText, "note should persist an immediate draft");

await commands.learn.handler(`approve ${id} --confirm`, { cwd: root });
const docsAgents = readFileSync(join(root, "docs/AGENTS.md"), "utf8");
assert(docsAgents.includes("## Agent Learnings"), "custom repoAgentsPath should receive approved rule");
assert(!existsSync(join(root, "AGENTS.md")), "default AGENTS.md should not be created when repoAgentsPath is configured");

console.log(`config root=${root} id=${id}`);
