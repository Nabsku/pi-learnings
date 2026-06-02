import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLearning } from "../src/store.ts";
import { draftLearning } from "../src/draft.ts";

const root = mkdtempSync(join(tmpdir(), "pll-model-draft-"));
writeFileSync(join(root, ".pi-learnings-test-root"), "");
mkdirSync(join(root, ".pi"), { recursive: true });
const customLearningPrompt = "Write terse repo rules for this team. Return JSON only.";
writeFileSync(join(root, ".pi/learnings.json"), JSON.stringify({
  version: 1,
  prompt: customLearningPrompt,
  modelOverrides: {
    draftRule: { model: "fake-provider/fake-model", thinkingLevel: "high" },
  },
}, null, 2));

const calls: Array<{ model: unknown; context: unknown; options: unknown }> = [];
const fakeModel = { provider: "fake-provider", id: "fake-model", api: "fake-api" };
const ctx = {
  modelRegistry: {
    find(provider: string, modelId: string) {
      assert.equal(provider, "fake-provider");
      assert.equal(modelId, "fake-model");
      return fakeModel;
    },
    async getApiKeyAndHeaders(model: unknown) {
      assert.equal(model, fakeModel);
      return { ok: true, apiKey: "fake-key", headers: { "x-test": "yes" } };
    },
  },
} as unknown as ExtensionContext;

const record = createLearning(root, {
  source: { selector: "manual", role: "unknown", excerpt: "Assistant claimed tests passed after pnpm test failed." },
  issue: { description: "Claimed tests passed even though pnpm test failed." },
  classification: "verification_overclaim",
  recommendedTarget: { kind: "repo-agents", path: "AGENTS.md" },
});

record.draft = await draftLearning(root, record, ctx, {
  complete: async (model, context, options) => {
    calls.push({ model, context, options });
    return {
      role: "assistant",
      api: "fake-api",
      provider: "fake-provider",
      model: "fake-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify({ proposedText: "- Only report tests as passed after running the exact test command and seeing a successful exit.", rationale: "Uses the reported failed test evidence.", risk: "low" }) }],
    };
  },
});

assert.equal(calls.length, 1);
assert.equal(calls[0]?.model, fakeModel);
assert.deepEqual(calls[0]?.options, { reasoning: "high", apiKey: "fake-key", headers: { "x-test": "yes" } });
assert.equal((calls[0]?.context as { systemPrompt?: string }).systemPrompt, customLearningPrompt);
assert.match(JSON.stringify(calls[0]?.context), /Claimed tests passed/);
assert.equal(record.draft.proposedText, "- Only report tests as passed after running the exact test command and seeing a successful exit.");
assert.equal(record.draft.rationale, "Uses the reported failed test evidence.");
assert.equal(record.draft.risk, "low");

const defaultRoot = mkdtempSync(join(tmpdir(), "pll-model-draft-default-"));
mkdirSync(join(defaultRoot, ".pi"), { recursive: true });
writeFileSync(join(defaultRoot, ".pi/learnings.json"), JSON.stringify({ version: 1, modelOverrides: {} }, null, 2));
const defaultModel = { provider: "user-provider", id: "user-default", api: "fake-api" };
const defaultCtx = {
  model: defaultModel,
  modelRegistry: {
    find() {
      throw new Error("default model path should not resolve a hardcoded override");
    },
    async getApiKeyAndHeaders(model: unknown) {
      assert.equal(model, defaultModel);
      return { ok: true, apiKey: "default-key", headers: undefined };
    },
  },
} as unknown as ExtensionContext;
const defaultRecord = createLearning(defaultRoot, {
  source: { selector: "manual", role: "unknown", excerpt: "Assistant drifted scope." },
  issue: { description: "Assistant made unrelated refactors." },
  classification: "scope_drift",
  recommendedTarget: { kind: "repo-agents", path: "AGENTS.md" },
});
const defaultDraft = await draftLearning(defaultRoot, defaultRecord, defaultCtx, {
  complete: async (model, _context, options) => {
    assert.equal(model, defaultModel);
    assert.deepEqual(options, { reasoning: undefined, apiKey: "default-key", headers: undefined });
    return {
      role: "assistant",
      api: "fake-api",
      provider: "user-provider",
      model: "user-default",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify({ proposedText: "- Keep changes scoped to the user's requested task.", rationale: "Uses the user's default model.", risk: "low" }) }],
    };
  },
});
assert.equal(defaultDraft.proposedText, "- Keep changes scoped to the user's requested task.");
assert.equal(defaultDraft.rationale, "Uses the user's default model.");

console.log("model-draft ok");
