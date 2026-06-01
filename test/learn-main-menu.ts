import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import learningLoop from "../index.ts";
import { createLearning, moveLearning, saveLearning } from "../src/store.ts";

type Command = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function install() {
  const commands: Record<string, Command> = {};
  const messages: Array<{ content: string; details?: unknown }> = [];
  learningLoop({
    on() {},
    registerTool() {},
    registerCommand(name: string, command: Command) { commands[name] = command; },
    sendMessage(message: { content: string; details?: unknown }) { messages.push(message); },
  } as never);
  return { commands, messages };
}

function seedRecord(root: string, issue: string) {
  const record = createLearning(root, {
    source: { selector: "manual", role: "unknown", excerpt: issue },
    issue: { description: issue },
    classification: "verification_overclaim",
    recommendedTarget: { kind: "repo-agents", path: "AGENTS.md" },
  });
  record.draft = { section: "Agent Learnings", proposedText: "- Verify before claiming success.", rationale: "Test", duplicateCheck: { searched: ["AGENTS.md"], similarExistingRule: null }, risk: "low" };
  saveLearning(root, record);
  return record;
}

const { commands, messages } = install();

// Bare /learn in no-UI mode is concise help, not the old full usage dump.
{
  const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-menu-no-ui-"));
  writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");
  await commands.learn.handler("", { cwd: root, hasUI: false });
  const content = messages.at(-1)?.content ?? "";
  assert(content.includes("/learn opens the learning menu when UI is available."), "bare no-UI help should explain /learn menu behavior");
  assert(content.includes("/learn note <what went wrong>"), "bare no-UI help should point to note");
  assert(content.includes("Advanced fallback:"), "bare no-UI help should mention advanced fallbacks");
}

// Bare /learn opens a main menu and Capture delegates to the existing picker flow.
{
  const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-menu-capture-"));
  writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");
  const seen: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    sessionManager: { getEntries: () => [
      { id: "u1", type: "message", timestamp: "2026-05-31T10:00:00.000Z", message: { role: "user", content: "Fix tests" } },
      { id: "a1", type: "message", timestamp: "2026-05-31T10:01:00.000Z", message: { role: "assistant", content: "Tests pass." } },
    ] },
    ui: {
      async select(title: string, options: string[]) {
        seen.push(`select:${title}:${options.join("|")}`);
        if (title === "Learning loop") {
          assert(options.join("|") === "Capture from recent turn|Review pending drafts|Browse learnings|Quick note", "main menu should expose required actions");
          return "Capture from recent turn";
        }
        if (title === "Select the turn to learn from") return options[0];
        if (title === "Use this turn?") return "Use this turn";
        throw new Error(`unexpected select: ${title}`);
      },
      async input(title: string, placeholder?: string) { seen.push(`input:${title}`); return placeholder ?? "Claimed success without evidence."; },
      async editor(title: string, prefill?: string) { seen.push(`editor:${title}`); return title.startsWith("Read-only preview") ? prefill : "Verify before claiming."; },
    },
  };
  await commands.learn.handler("", ctx);
  assert(seen[0]?.startsWith("select:Learning loop:"), "bare UI learn should start at main menu");
  assert((messages.at(-1)?.content ?? "").includes("created:"), "capture action should create through existing picker flow");
}

// Review action delegates to existing draft review.
{
  const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-menu-review-"));
  writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");
  const record = seedRecord(root, "Claimed tests passed without running them.");
  const titles: string[] = [];
  await commands.learn.handler("", {
    cwd: root,
    hasUI: true,
    ui: {
      async select(title: string, options: string[]) {
        titles.push(title);
        if (title === "Learning loop") return "Review pending drafts";
        if (title === "Select draft to review") return options[0];
        if (title === "Apply or reject this draft") return "Keep pending / Back";
        throw new Error(`unexpected select: ${title}`);
      },
      async editor() { return ""; },
    },
  });
  assert(titles.includes("Select draft to review"), "review menu action should enter existing draft review picker");
  assert(existsSync(join(root, ".pi/learnings/pending", `${record.id}.json`)), "review/back should leave draft pending");
}

// Browse action lists statuses and lets users inspect without typing an id.
{
  const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-menu-browse-"));
  writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");
  const pending = seedRecord(root, "Pending issue");
  const applied = moveLearning(root, seedRecord(root, "Applied issue"), "applied");
  const rejected = moveLearning(root, seedRecord(root, "Rejected issue"), "rejected");
  let preview = "";
  await commands.learn.handler("", {
    cwd: root,
    hasUI: true,
    ui: {
      async select(title: string, options: string[]) {
        if (title === "Learning loop") return "Browse learnings";
        if (title === "Browse learnings") {
          assert(options.some((o) => o.includes("pending") && o.includes(pending.id)), "browse should include pending records");
          assert(options.some((o) => o.includes("applied") && o.includes(applied.id)), "browse should include applied records");
          assert(options.some((o) => o.includes("rejected") && o.includes(rejected.id)), "browse should include rejected records");
          return options.find((o) => o.includes("applied"));
        }
        throw new Error(`unexpected select: ${title}`);
      },
      async editor(title: string, prefill?: string) { assert(title === "Learning detail", "browse should open detail preview"); preview = prefill ?? ""; return prefill; },
    },
  });
  assert(preview.includes(`# ${applied.id}`), "browse preview should render selected learning details");
}

// Quick note prompts for issue and creates a drafted pending learning.
{
  const root = mkdtempSync(join(tmpdir(), "pi-learning-loop-menu-note-"));
  writeFileSync(join(root, "AGENTS.md"), "# Repo Rules\n", "utf8");
  await commands.learn.handler("", {
    cwd: root,
    hasUI: true,
    ui: {
      async select(title: string) { assert(title === "Learning loop", "quick note should start from main menu"); return "Quick note"; },
      async input(title: string) { assert(title === "What went wrong?", "quick note should prompt for issue"); return "Used the wrong package manager command."; },
    },
  });
  const content = messages.at(-1)?.content ?? "";
  const id = /learn_[A-Za-z0-9_Z]+_[a-f0-9]{6}/.exec(content)?.[0];
  assert(id, "quick note should report created learning id");
  const record = JSON.parse(readFileSync(join(root, ".pi/learnings/pending", `${id}.json`), "utf8"));
  assert(record.draft?.proposedText, "quick note should draft the learning");
}

console.log("learn main menu tests passed");
