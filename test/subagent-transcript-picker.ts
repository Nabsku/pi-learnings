import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentPickableTurns } from "../src/interactive.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "pi-learnings-subagent-transcript-"));
const transcript = join(root, "agent_456.output");
writeFileSync(transcript, [
  JSON.stringify({
    isSidechain: true,
    agentId: "agent_456",
    type: "user",
    timestamp: "2026-06-02T11:00:00.000Z",
    message: { role: "user", content: "Verify the release." },
  }),
  JSON.stringify({
    isSidechain: true,
    agentId: "agent_456",
    type: "toolResult",
    timestamp: "2026-06-02T11:01:00.000Z",
    message: { role: "tool", content: "gh run watch failed with exit code 1" },
  }),
  JSON.stringify({
    isSidechain: true,
    agentId: "agent_456",
    type: "assistant",
    timestamp: "2026-06-02T11:02:00.000Z",
    message: { role: "assistant", content: "Release verified. All checks passed." },
  }),
].join("\n") + "\n");

const ctx = {
  cwd: root,
  sessionManager: {
    getEntries() {
      return [
        {
          id: "n1",
          type: "message",
          timestamp: "2026-06-02T11:03:00.000Z",
          message: {
            customType: "subagent-notification",
            content: "Background agent completed: release verifier",
            details: {
              id: "agent_456",
              description: "release verifier",
              status: "completed",
              outputFile: transcript,
              resultPreview: "Release verified.",
            },
          },
        },
      ];
    },
  },
} as never;

const turns = recentPickableTurns(ctx, 10);
const badSubagentTurn = turns.find((turn) => turn.id.includes("agent_456:2"));

assert(badSubagentTurn, "subagent transcript assistant turn should be selectable");
assert(badSubagentTurn.role === "assistant", "transcript assistant turn should keep assistant role");
assert(badSubagentTurn.source === "subagent", "transcript turn should be marked as subagent source");
assert(badSubagentTurn.sourceTurnId === "agent_456", "transcript turn should preserve agent id as source turn id");
assert(badSubagentTurn.evidenceExcerpt?.includes("exit code 1"), "transcript overclaim should pair with failed tool output inside the subagent transcript");
assert(badSubagentTurn.label === `[likely] subagent result · overclaim/tool-failure · #${badSubagentTurn.id}`, "subagent transcript overclaim should get a subagent likely label");

console.log("subagent-transcript-picker ok");
