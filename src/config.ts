import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ModelOverride = {
  model?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
};

export type LearningLoopConfig = {
  version: 1;
  learningsDir: string;
  repoAgentsPath: string;
  globalAgentsPath: string;
  globalSystemPath: string;
  maxExcerptChars: number;
  modelOverrides: {
    draftRule?: ModelOverride;
    classifyIssue?: ModelOverride;
  };
};

export const DEFAULT_CONFIG: LearningLoopConfig = {
  version: 1,
  learningsDir: ".pi/learnings",
  repoAgentsPath: "AGENTS.md",
  globalAgentsPath: "~/.pi/agent/AGENTS.md",
  globalSystemPath: "~/.pi/agent/APPEND_SYSTEM.md",
  maxExcerptChars: 4000,
  modelOverrides: {},
};

export function configPath(root: string): string {
  return resolve(root, ".pi", "learnings.json");
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function modelOverride(value: unknown, fallback?: ModelOverride): ModelOverride | undefined {
  if (!value || typeof value !== "object") return fallback ? { ...fallback } : undefined;
  const raw = value as Partial<ModelOverride>;
  const out: ModelOverride = {};
  if (typeof raw.model === "string" && raw.model.trim()) out.model = raw.model.trim();
  if (["minimal", "low", "medium", "high", "xhigh"].includes(String(raw.thinkingLevel))) out.thinkingLevel = raw.thinkingLevel;
  return Object.keys(out).length ? out : fallback ? { ...fallback } : undefined;
}

function modelOverrides(value: unknown): LearningLoopConfig["modelOverrides"] {
  const raw = value && typeof value === "object" ? value as Partial<LearningLoopConfig["modelOverrides"]> : {};
  return {
    draftRule: modelOverride(raw.draftRule),
    classifyIssue: modelOverride(raw.classifyIssue),
  };
}

function safeRepoRelative(root: string, value: unknown, fallback: string): string {
  const raw = stringValue(value, fallback);
  const resolved = resolve(root, raw);
  const repo = resolve(root);
  if (resolved !== repo && !resolved.startsWith(`${repo}/`)) return fallback;
  return raw;
}

function safeGlobalPiPath(value: unknown, fallback: string): string {
  const raw = stringValue(value, fallback);
  const home = process.env.HOME;
  const expanded = raw.startsWith("~/") && home ? `${home}/${raw.slice(2)}` : raw;
  const allowedName = fallback.endsWith("APPEND_SYSTEM.md") ? "APPEND_SYSTEM.md" : "AGENTS.md";
  if (raw === `~/.pi/agent/${allowedName}`) return raw;
  if (home && expanded === `${home}/.pi/agent/${allowedName}`) return raw;
  return fallback;
}

export function loadConfig(root: string): LearningLoopConfig {
  const path = configPath(root);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LearningLoopConfig>;
  return {
    version: 1,
    learningsDir: safeRepoRelative(root, parsed.learningsDir, DEFAULT_CONFIG.learningsDir),
    repoAgentsPath: safeRepoRelative(root, parsed.repoAgentsPath, DEFAULT_CONFIG.repoAgentsPath),
    globalAgentsPath: safeGlobalPiPath(parsed.globalAgentsPath, DEFAULT_CONFIG.globalAgentsPath),
    globalSystemPath: safeGlobalPiPath(parsed.globalSystemPath, DEFAULT_CONFIG.globalSystemPath),
    maxExcerptChars: numberValue(parsed.maxExcerptChars, DEFAULT_CONFIG.maxExcerptChars),
    modelOverrides: modelOverrides(parsed.modelOverrides),
  };
}
