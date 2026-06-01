import { recentPickableTurns } from "../src/interactive.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ctxFor(entries: Array<{ id: string; role: "user" | "assistant" | "tool"; content: string }>) {
  return {
    sessionManager: {
      getEntries() {
        return entries.map((entry, index) => ({
          id: entry.id,
          type: "message",
          timestamp: `2026-05-31T12:${String(index).padStart(2, "0")}:00.000Z`,
          message: { role: entry.role, content: entry.content },
        }));
      },
    },
  } as never;
}

{
  const turns = recentPickableTurns(ctxFor([
    { id: "u1", role: "user", content: "Fix tests and docs" },
    { id: "a1", role: "assistant", content: "I will run checks and patch README." },
    { id: "t_lint", role: "tool", content: "npm run lint failed with exit code 1" },
    { id: "t_patch", role: "tool", content: "patch failed: old_string not found in README.md" },
    { id: "a2", role: "assistant", content: "I updated README.md. Lint still fails." },
  ]), 10);
  const claim = turns.find((turn) => turn.id === "a2");
  assert(claim?.evidenceTurnId === "t_patch", "file update claim should pair to the matching patch/write failure");
  assert(claim?.label.includes("README.md"), "file update evidence should include the file failure excerpt");
  assert((claim?.evidenceTurnId as string | undefined) !== "t_lint", "file update claim should not pair to unrelated lint failure");
}

{
  const turns = recentPickableTurns(ctxFor([
    { id: "u1", role: "user", content: "Fix tests and docs" },
    { id: "a1", role: "assistant", content: "I will run checks and patch README." },
    { id: "t_patch", role: "tool", content: "patch failed: old_string not found in README.md" },
    { id: "t_test", role: "tool", content: "pnpm test failed with exit code 1" },
    { id: "a2", role: "assistant", content: "Tests passed. README still needs work." },
  ]), 10);
  const claim = turns.find((turn) => turn.id === "a2");
  assert(claim?.evidenceTurnId === "t_test", "test success claim should pair to the matching test failure");
  assert(claim?.label.includes("pnpm test failed"), "test claim evidence should include test failure output");
  assert((claim?.evidenceTurnId as string | undefined) !== "t_patch", "test success claim should not pair to unrelated file patch failure");
}

console.log("picker-semantic-match ok");
