import { recentPickableTurns } from "../src/interactive.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const unrelatedFailureCtx = {
  sessionManager: {
    getEntries() {
      return [
        {
          id: "u1",
          type: "message",
          timestamp: "2026-05-31T10:00:00.000Z",
          message: { role: "user", content: "Fix the docs" },
        },
        {
          id: "t_fail",
          type: "message",
          timestamp: "2026-05-31T10:01:00.000Z",
          message: { role: "tool", content: "pytest failed with exit code 1" },
        },
        {
          id: "a_tool",
          type: "message",
          timestamp: "2026-05-31T10:02:00.000Z",
          message: { role: "assistant", content: "I will update README now." },
        },
        {
          id: "t_success",
          type: "message",
          timestamp: "2026-05-31T10:03:00.000Z",
          message: { role: "tool", content: "write_file success: README.md" },
        },
        {
          id: "a_claim",
          type: "message",
          timestamp: "2026-05-31T10:04:00.000Z",
          message: { role: "assistant", content: "Done — README works now." },
        },
      ];
    },
  },
} as never;

const turns = recentPickableTurns(unrelatedFailureCtx, 10);
const claim = turns.find((turn) => turn.id === "a_claim");

assert(claim, "claim turn should be selectable");
assert(!claim.evidenceTurnId, "claim should not be paired to an unrelated failure before the previous assistant turn");
assert(!claim.label.includes("pytest failed"), "claim label should not surface unrelated stale failure output");

const relatedFailureCtx = {
  sessionManager: {
    getEntries() {
      return [
        {
          id: "u1",
          type: "message",
          timestamp: "2026-05-31T11:00:00.000Z",
          message: { role: "user", content: "Fix tests" },
        },
        {
          id: "a_tool",
          type: "message",
          timestamp: "2026-05-31T11:01:00.000Z",
          message: { role: "assistant", content: "Running tests." },
        },
        {
          id: "t_fail",
          type: "message",
          timestamp: "2026-05-31T11:02:00.000Z",
          message: { role: "tool", content: "npm test failed with exit code 1" },
        },
        {
          id: "a_claim",
          type: "message",
          timestamp: "2026-05-31T11:03:00.000Z",
          message: { role: "assistant", content: "Tests passed." },
        },
      ];
    },
  },
} as never;

const relatedTurns = recentPickableTurns(relatedFailureCtx, 10);
const relatedClaim = relatedTurns.find((turn) => turn.id === "a_claim");

assert(relatedClaim?.evidenceTurnId === "t_fail", "claim should be paired to the specific immediately related failing tool turn");
assert(relatedClaim?.label.includes("npm test failed"), "claim should include the specific contradictory tool output");

console.log("picker-specific-tool ok");
