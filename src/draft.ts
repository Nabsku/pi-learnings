import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { LearningClassification, LearningDraft, LearningRecord, LearningTargetKind, SimilarLearningCandidate } from "./types.ts";
import { loadConfig, type ModelOverride } from "./config.ts";

const CLASSIFIERS: Array<{ classification: LearningClassification; terms: RegExp; rule: string; rationale: string }> = [
  { classification: "verification_overclaim", terms: /test|verify|verification|passed|green|checked|ran/i, rule: "- Do not claim a check passed unless you ran the exact command and can report the result.", rationale: "The issue describes overclaiming or weak verification." },
  { classification: "scope_drift", terms: /scope|unrelated|refactor|format|churn|extra/i, rule: "- Keep fixes surgical; do not make unrelated refactors, formatting churn, or speculative improvements while addressing a specific issue.", rationale: "The issue describes scope drift or unrelated changes." },
  { classification: "unsafe_edit", terms: /dirty|overwrite|user work|untracked|unstaged|clobber/i, rule: "- Before editing, check for dirty or untracked user work and avoid touching it unless the user explicitly approves the overlap.", rationale: "The issue describes unsafe overlap with existing work." },
  { classification: "wrong_tool", terms: /npm|pnpm|bun|yarn|tool|package manager|command/i, rule: "- Use the repo's documented package manager and commands; verify scripts before substituting alternatives.", rationale: "The issue describes using the wrong tool or command." },
  { classification: "stale_data", terms: /stale|old log|tail|cached|fresh data|outdated/i, rule: "- Do not rely on stale log tails or cached data for current facts; verify freshness before reporting stats or conclusions.", rationale: "The issue describes stale data being treated as current." },
];

const TRANSIENT = /network timeout|rate limit|429|temporary|flaky|one-off|permission denied|install missing/i;

const DEFAULT_LEARNING_PROMPT = "Draft one durable, repo-local agent learning rule. Return only JSON with proposedText, rationale, and risk (low|medium|high). Keep proposedText a single markdown bullet starting with '- '. Do not include secrets or one-off task facts.";

type DraftCompletion = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
export type DraftLearningDeps = { complete?: DraftCompletion };

type SelectedModel = {
  model: Model<any>;
  thinkingLevel?: ModelOverride["thinkingLevel"];
};

function selectModel(ctx: ExtensionContext, override?: ModelOverride): SelectedModel | undefined {
  const modelRef = parseModelRef(override?.model);
  if (modelRef) {
    const model = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
    return model ? { model, thinkingLevel: override?.thinkingLevel } : undefined;
  }
  return ctx.model ? { model: ctx.model, thinkingLevel: override?.thinkingLevel } : undefined;
}

export function classifyIssue(description: string): LearningClassification {
  if (TRANSIENT.test(description)) return "transient";
  return CLASSIFIERS.find((item) => item.terms.test(description))?.classification ?? "other";
}

const CLASSIFICATION_VALUES: LearningClassification[] = ["verification_overclaim", "scope_drift", "unsafe_edit", "wrong_tool", "context_miss", "stale_data", "transient", "other"];

function parseClassificationResponse(text: string): LearningClassification | undefined {
  const jsonText = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text;
  try {
    const parsed = JSON.parse(jsonText) as { classification?: unknown };
    return CLASSIFICATION_VALUES.includes(parsed.classification as LearningClassification) ? parsed.classification as LearningClassification : undefined;
  } catch {
    const value = CLASSIFICATION_VALUES.find((item) => new RegExp(`\\b${item}\\b`, "i").test(text));
    return value;
  }
}

export async function classifyIssueWithModel(root: string, description: string, ctx?: ExtensionContext, deps: DraftLearningDeps = {}): Promise<LearningClassification> {
  const deterministic = classifyIssue(description);
  if (!ctx?.modelRegistry) return deterministic;
  const config = loadConfig(root);
  const override = config.modelOverrides.classifyIssue;
  const selected = selectModel(ctx, override);
  if (!selected) return deterministic;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected.model);
  if (!auth.ok) return deterministic;
  const complete = deps.complete ?? completeSimple;
  const response = await complete(selected.model, {
    systemPrompt: `Classify an agent learning issue. Return only JSON: {"classification":"..."}. Allowed classifications: ${CLASSIFICATION_VALUES.join(", ")}.`,
    messages: [{ role: "user", timestamp: Date.now(), content: description }],
  }, {
    reasoning: selected.thinkingLevel,
    apiKey: auth.apiKey,
    headers: auth.headers,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") return deterministic;
  return parseClassificationResponse(textFromAssistant(response)) ?? deterministic;
}

export function recommendTarget(classification: LearningClassification): { kind: LearningTargetKind; path: string } {
  if (classification === "transient") return { kind: "note-only", path: ".pi/learnings" };
  return { kind: "repo-agents", path: "AGENTS.md" };
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 3);
}

function similarityScore(existing: string, proposed: string): number {
  const proposedTokens = [...new Set(tokenize(proposed))];
  if (!proposedTokens.length) return 0;
  const existingTokens = new Set(tokenize(existing));
  const hits = proposedTokens.filter((word) => existingTokens.has(word)).length;
  return hits / proposedTokens.length;
}

export function findSimilarRules(root: string, searched: string[], proposed: string): SimilarLearningCandidate[] {
  return searched.flatMap((rel) => {
    const content = readIfExists(join(root, rel));
    return content.split(/\r?\n/).flatMap((line, index) => {
      const existingText = line.trim();
      if (!existingText.startsWith("- ")) return [];
      const score = existingText === proposed ? 1 : similarityScore(existingText, proposed);
      if (score < 0.45) return [];
      const candidate: SimilarLearningCandidate = {
        id: `${rel}:${index + 1}`,
        path: rel,
        section: "Agent Learnings",
        line: index + 1,
        existingText,
        score: Number(score.toFixed(2)),
        reason: existingText === proposed ? "exact duplicate" : "shares key rule terms",
      };
      return [candidate];
    });
  }).sort((a, b) => b.score - a.score);
}

function duplicateCheck(root: string, searched: string[], proposed: string): LearningDraft["duplicateCheck"] {
  const similar = findSimilarRules(root, searched, proposed);
  const top = similar[0];
  return {
    searched,
    similarExistingRule: top?.existingText ?? null,
    similar,
    suggestedAction: top ? (top.score >= 0.98 ? "reject" : "update") : "append",
  };
}

function deterministicDraft(root: string, record: LearningRecord): LearningDraft {
  const config = loadConfig(root);
  const classification = record.classification === "other" ? classifyIssue(record.issue.description) : record.classification;
  const classifier = CLASSIFIERS.find((item) => item.classification === classification);
  const proposedText = classifier?.rule ?? "- When a mistake is identified, generalize the root behavior into a short rule and verify the rule is not already covered before adding it.";
  const searched = [config.repoAgentsPath, ".pi/workflows.json"];
  const duplicates = duplicateCheck(root, searched, proposedText);
  if (classification === "transient") {
    return { section: "Learning Notes", proposedText: "", rationale: "This looks transient or environment-specific; save as a note instead of adding prompt policy.", duplicateCheck: { searched, similarExistingRule: null, similar: [], suggestedAction: "append" }, risk: "medium" };
  }
  return { section: "Agent Learnings", proposedText, rationale: classifier?.rationale ?? "The issue should become a concise durable behavior rule.", duplicateCheck: duplicates, risk: duplicates.similar?.length ? "medium" : "low" };
}

function parseModelRef(ref: string | undefined): { provider: string; modelId: string } | undefined {
  if (!ref) return undefined;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
}

function parseDraftResponse(text: string, fallback: LearningDraft): LearningDraft | undefined {
  const jsonText = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text;
  try {
    const parsed = JSON.parse(jsonText) as Partial<LearningDraft>;
    if (typeof parsed.proposedText !== "string" || !parsed.proposedText.trim()) return undefined;
    return {
      section: typeof parsed.section === "string" && parsed.section.trim() ? parsed.section.trim() : fallback.section,
      proposedText: parsed.proposedText.trim(),
      rationale: typeof parsed.rationale === "string" && parsed.rationale.trim() ? parsed.rationale.trim() : fallback.rationale,
      duplicateCheck: fallback.duplicateCheck,
      risk: parsed.risk === "medium" || parsed.risk === "high" || parsed.risk === "low" ? parsed.risk : fallback.risk,
    };
  } catch {
    return undefined;
  }
}

async function modelDraft(root: string, record: LearningRecord, fallback: LearningDraft, override: ModelOverride | undefined, prompt: string | undefined, ctx: ExtensionContext, deps: DraftLearningDeps): Promise<LearningDraft | undefined> {
  const selected = selectModel(ctx, override);
  if (!selected) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected.model);
  if (!auth.ok) return undefined;
  const complete = deps.complete ?? completeSimple;
  const response = await complete(selected.model, {
    systemPrompt: prompt ?? DEFAULT_LEARNING_PROMPT,
    messages: [{
      role: "user",
      timestamp: Date.now(),
      content: JSON.stringify({
        issue: record.issue,
        source: record.source,
        classification: record.classification,
        recommendedTarget: record.recommendedTarget,
        fallbackRule: fallback.proposedText,
      }),
    }],
  }, {
    reasoning: selected.thinkingLevel,
    apiKey: auth.apiKey,
    headers: auth.headers,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
  return parseDraftResponse(textFromAssistant(response), fallback);
}

export async function draftLearning(root: string, record: LearningRecord, ctx?: ExtensionContext, deps: DraftLearningDeps = {}): Promise<LearningDraft> {
  const config = loadConfig(root);
  const fallback = deterministicDraft(root, record);
  if (!ctx?.modelRegistry || record.classification === "transient") return fallback;
  const drafted = await modelDraft(root, record, fallback, config.modelOverrides.draftRule, config.prompt, ctx, deps) ?? fallback;
  if (drafted.proposedText) {
    drafted.duplicateCheck = duplicateCheck(root, drafted.duplicateCheck.searched, drafted.proposedText);
    drafted.risk = drafted.duplicateCheck.similar?.length && drafted.risk === "low" ? "medium" : drafted.risk;
  }
  return drafted;
}
