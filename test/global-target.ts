import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";
import { applyLearningRule, previewLearningRule } from "../src/apply.ts";
import { createLearning, saveLearning } from "../src/store.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-global-"));
const oldHome = process.env.HOME;
process.env.HOME = root;
const piHome = join(root, ".pi/agent");
writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");
writeFileSync(join(root, ".pi-placeholder"), "", "utf8");

const configDir = join(root, ".pi");
await import("node:fs").then(({ mkdirSync }) => mkdirSync(configDir, { recursive: true }));
writeFileSync(join(configDir, "learning-loop.json"), JSON.stringify({
  version: 1,
  learningsDir: ".pi/learnings",
  repoAgentsPath: "AGENTS.md",
  globalAgentsPath: join(piHome, "AGENTS.md"),
  globalSystemPath: join(piHome, "APPEND_SYSTEM.md"),
  maxExcerptChars: 4000,
  modelOverrides: {},
}, null, 2));
await import("node:fs").then(({ mkdirSync }) => mkdirSync(piHome, { recursive: true }));
writeFileSync(join(piHome, "AGENTS.md"), "# Global Pi Rules\n", "utf8");
writeFileSync(join(piHome, "APPEND_SYSTEM.md"), "# Appended System\n", "utf8");

const record = createLearning(root, {
  source: { selector: "manual", role: "unknown", excerpt: "Pi repeats a global mistake" },
  issue: { description: "Pi repeats a global mistake" },
  classification: "verification_overclaim",
  recommendedTarget: { kind: "global-agents", path: join(piHome, "AGENTS.md") },
});
record.draft = {
  section: "Agent Learnings",
  proposedText: "- Verify commands before claiming success globally.",
  rationale: "Global behavior issue",
  duplicateCheck: { searched: [join(piHome, "AGENTS.md")], similarExistingRule: null },
  risk: "medium",
};
saveLearning(root, record);

const preview = previewLearningRule(root, record);
assert(preview.message.includes("global Pi rule"), "global preview should name global Pi writes");
assert(preview.message.includes("--confirm-global"), "global preview should require stronger confirmation flag");

const direct = applyLearningRule(root, record, { allowGlobal: false });
assert(!direct.applied, "global apply must be blocked without explicit global allowance");
assert(readFileSync(join(piHome, "AGENTS.md"), "utf8") === "# Global Pi Rules\n", "blocked global apply must not write global file");

const applied = applyLearningRule(root, record, { allowGlobal: true });
assert(applied.applied, "global apply should work with explicit global allowance");
assert(readFileSync(join(piHome, "AGENTS.md"), "utf8").includes("Verify commands before claiming success globally."), "global AGENTS.md should receive the approved rule");
assert(readFileSync(join(root, "AGENTS.md"), "utf8") === "# Repo Rules\n", "global apply must not touch repo AGENTS.md");

const commands: Record<string, { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }> = {};
const messages: Array<{ content: string }> = [];
learningLoop({
  on() {},
  registerTool() {},
  registerCommand(name: string, command: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) { commands[name] = command; },
  sendMessage(message: { content: string }) { messages.push(message); },
} as never);

const cliRecord = createLearning(root, {
  source: { selector: "manual", role: "unknown", excerpt: "global cli" },
  issue: { description: "global cli" },
  classification: "other",
  recommendedTarget: { kind: "global-agents", path: join(piHome, "AGENTS.md") },
});
cliRecord.draft = { ...record.draft, proposedText: "- CLI global approval needs the global flag." };
saveLearning(root, cliRecord);

const beforeCli = readFileSync(join(piHome, "AGENTS.md"), "utf8");
await commands.learn.handler(`approve ${cliRecord.id} --confirm`, { cwd: root });
assert(readFileSync(join(piHome, "AGENTS.md"), "utf8") === beforeCli, "normal --confirm must not approve global writes");
assert((messages.at(-1)?.content ?? "").includes("--confirm-global"), "CLI should tell user the stronger global confirmation syntax");

await commands.learn.handler(`approve ${cliRecord.id} --confirm-global`, { cwd: root });
assert(readFileSync(join(piHome, "AGENTS.md"), "utf8").includes("CLI global approval needs the global flag."), "--confirm-global should approve global write");
assert(existsSync(join(root, ".pi/learnings/applied", `${cliRecord.id}.json`)), "confirmed global CLI apply should move learning to applied");

const unsafeConfigRoot = mkdtempSync(join(tmpdir(), "pi-learning-loop-global-unsafe-config-"));
process.env.HOME = unsafeConfigRoot;
await import("node:fs").then(({ mkdirSync }) => mkdirSync(join(unsafeConfigRoot, ".pi"), { recursive: true }));
writeFileSync(join(unsafeConfigRoot, ".pi/learning-loop.json"), JSON.stringify({
  version: 1,
  learningsDir: ".pi/learnings",
  repoAgentsPath: "AGENTS.md",
  globalAgentsPath: "~/.pi/agent/OTHER.md",
  globalSystemPath: "~/.pi/agent/SYSTEM.md",
  maxExcerptChars: 4000,
  modelOverrides: {},
}, null, 2));
const { loadConfig } = await import("../src/config.ts");
const unsafeConfig = loadConfig(unsafeConfigRoot);
assert(unsafeConfig.globalAgentsPath === "~/.pi/agent/AGENTS.md", "globalAgentsPath should only allow canonical AGENTS.md");
assert(unsafeConfig.globalSystemPath === "~/.pi/agent/APPEND_SYSTEM.md", "globalSystemPath should only allow canonical APPEND_SYSTEM.md");

console.log("global-target ok");
process.env.HOME = oldHome;
