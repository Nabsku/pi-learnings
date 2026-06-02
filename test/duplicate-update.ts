import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftLearning } from "../src/draft.ts";
import { applyLearningRule } from "../src/apply.ts";
import { createLearning, moveLearning } from "../src/store.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "pi-learnings-duplicate-update-"));
const agentsPath = join(root, "AGENTS.md");
writeFileSync(agentsPath, [
  "# Rules",
  "",
  "## Agent Learnings",
  "- Do not claim tests passed unless you ran the exact command.",
  "",
].join("\n"), "utf8");

const record = createLearning(root, {
  source: { selector: "manual", role: "assistant", excerpt: "Claimed all checks passed after a failed test." },
  issue: { description: "Claimed tests passed after failed command output." },
  classification: "verification_overclaim",
  recommendedTarget: { kind: "repo-agents", path: "AGENTS.md" },
});
record.draft = await draftLearning(root, record);

const candidate = record.draft.duplicateCheck.similar?.[0];
assert(candidate, "draft should include ranked similar candidates");
assert(candidate.path === "AGENTS.md", `candidate path should be AGENTS.md, got ${candidate.path}`);
assert(candidate.line === 4, `candidate line should be 4, got ${candidate.line}`);
assert(candidate.existingText.includes("Do not claim tests passed"), "candidate should include existing rule text");
assert(record.draft.duplicateCheck.suggestedAction === "update", "similar rule should recommend update");

const wrongPathRecord = createLearning(root, {
  source: { selector: "manual", role: "assistant", excerpt: "Another bad claim." },
  issue: { description: "Claimed tests passed after failed command output." },
  classification: "verification_overclaim",
  recommendedTarget: { kind: "repo-agents", path: "OTHER.md" },
});
wrongPathRecord.draft = record.draft;
const wrongPathResult = applyLearningRule(root, wrongPathRecord, { update: candidate });
assert(!wrongPathResult.applied, "update candidate path mismatch should not write another target file");
assert(wrongPathResult.message.includes("candidate path"), `mismatch should explain candidate path problem, got ${wrongPathResult.message}`);
assert(!existsSync(join(root, "OTHER.md")), "mismatched update should not create another target file");

const result = applyLearningRule(root, record, { update: candidate });
assert(result.applied, result.message);
const updated = readFileSync(agentsPath, "utf8");
assert(!updated.includes("Do not claim tests passed unless you ran the exact command."), "old similar bullet should be replaced");
assert(updated.includes(record.draft.proposedText), "new proposed bullet should be present");
assert(updated.split(record.draft.proposedText).length === 2, "new proposed bullet should appear exactly once");

moveLearning(root, record, "applied");
assert(existsSync(join(root, ".pi/learnings/applied", `${record.id}.json`)), "record can be moved applied after update");

console.log("duplicate-update ok");
