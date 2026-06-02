import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { LearningRecord, SimilarLearningCandidate } from "./types.ts";
import { loadConfig } from "./config.ts";

export type ApplyResult = { applied: boolean; path: string; message: string };
export type ApplyOptions = { allowGlobal?: boolean; update?: SimilarLearningCandidate; mode?: "append" | "update" };

type ResolvedTarget = { ok: true; absPath: string; displayPath: string; relPath: string; global: boolean } | { ok: false; message: string; relPath: string; global: boolean };

function ensureAgentLearningsSection(content: string): string {
  if (/^## Agent Learnings\s*$/m.test(content)) return content;
  const trimmed = content.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}## Agent Learnings\n`;
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return `${process.env.HOME ?? ""}/${path.slice(2)}`;
  return path;
}

function globalDisplayPath(absPath: string): string {
  const home = process.env.HOME;
  return home && absPath.startsWith(`${home}/`) ? `~/${absPath.slice(home.length + 1)}` : absPath;
}

export function resolveRepoAgentsPath(root: string, record: LearningRecord): { ok: true; absPath: string; relPath: string } | { ok: false; message: string; relPath: string } {
  const target = resolveLearningTarget(root, record);
  if (!target.ok) return { ok: false, relPath: target.relPath, message: target.message };
  if (target.global) return { ok: false, relPath: target.displayPath, message: `Target ${record.recommendedTarget.kind} is not a repo target.` };
  return { ok: true, absPath: target.absPath, relPath: target.relPath };
}

export function resolveLearningTarget(root: string, record: LearningRecord): ResolvedTarget {
  const config = loadConfig(root);
  if (record.recommendedTarget.kind === "repo-agents") {
    const rawPath = record.recommendedTarget.path || config.repoAgentsPath;
    if (isAbsolute(rawPath)) return { ok: false, relPath: rawPath, global: false, message: `Unsafe target path rejected: ${rawPath}` };
    const repo = resolve(root);
    const absPath = resolve(repo, rawPath);
    const relPath = relative(repo, absPath);
    if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return { ok: false, relPath: rawPath, global: false, message: `Unsafe target path rejected: ${rawPath}` };
    return { ok: true, absPath, relPath, displayPath: relPath, global: false };
  }

  if (record.recommendedTarget.kind === "global-agents" || record.recommendedTarget.kind === "global-system") {
    const configured = record.recommendedTarget.kind === "global-system" ? config.globalSystemPath : config.globalAgentsPath;
    const rawPath = record.recommendedTarget.path || configured;
    const absPath = resolve(expandHome(rawPath));
    const allowed = resolve(expandHome(configured));
    if (absPath !== allowed) return { ok: false, relPath: globalDisplayPath(absPath), global: true, message: `Unsafe global Pi target rejected: ${globalDisplayPath(absPath)}` };
    return { ok: true, absPath, relPath: globalDisplayPath(absPath), displayPath: globalDisplayPath(absPath), global: true };
  }

  return { ok: false, relPath: record.recommendedTarget.path, global: false, message: `Target ${record.recommendedTarget.kind} is not supported by apply.` };
}

export function previewLearningRule(root: string, record: LearningRecord): ApplyResult {
  if (record.status !== "pending") return { applied: false, path: "", message: `Learning ${record.id} is ${record.status}, not pending.` };
  if (!record.draft?.proposedText.trim()) return { applied: false, path: "", message: "No proposed rule to apply." };
  const target = resolveLearningTarget(root, record);
  if (!target.ok) return { applied: false, path: target.relPath, message: target.message };
  const scope = target.global ? "global Pi rule" : "repo rule";
  const confirm = target.global ? `Run: /learn approve ${record.id} --confirm-global` : `Run: /learn approve ${record.id} --confirm`;
  return { applied: false, path: target.displayPath, message: `Preview only; no ${scope} applied yet. Would apply ${record.id} to ${target.displayPath}:\n${record.draft.proposedText}\n\n${confirm}` };
}

function replaceExistingRule(current: string, proposed: string, candidate: SimilarLearningCandidate): { ok: true; updated: string } | { ok: false; message: string } {
  const lines = current.split(/\r?\n/);
  const lineIndex = typeof candidate.line === "number" ? candidate.line - 1 : lines.findIndex((line) => line.trim() === candidate.existingText.trim());
  if (lineIndex < 0 || lines[lineIndex]?.trim() !== candidate.existingText.trim()) {
    return { ok: false, message: "Cancelled. Existing rule changed since preview; draft left pending." };
  }
  lines[lineIndex] = proposed;
  return { ok: true, updated: lines.join("\n") };
}

export function applyLearningRule(root: string, record: LearningRecord, options: ApplyOptions = {}): ApplyResult {
  if (record.status !== "pending") return { applied: false, path: "", message: `Learning ${record.id} is ${record.status}, not pending.` };
  if (!record.draft?.proposedText.trim()) return { applied: false, path: "", message: "No proposed rule to apply." };
  const target = resolveLearningTarget(root, record);
  if (!target.ok) return { applied: false, path: target.relPath, message: target.message };
  if (target.global && !options.allowGlobal) return { applied: false, path: target.displayPath, message: `Global Pi writes require explicit confirmation. Run: /learn approve ${record.id} --confirm-global` };
  const current = existsSync(target.absPath) ? readFileSync(target.absPath, "utf8") : "# Instructions\n";
  if (options.update || options.mode === "update") {
    const candidate = options.update ?? record.draft.duplicateCheck.similar?.[0];
    if (!candidate) return { applied: false, path: target.displayPath, message: "No similar rule candidate selected for update." };
    if (candidate.path !== target.displayPath && candidate.path !== target.relPath) {
      return { applied: false, path: target.displayPath, message: `Cancelled. Update candidate path ${candidate.path} does not match target ${target.displayPath}; draft left pending.` };
    }
    const replaced = replaceExistingRule(current, record.draft.proposedText, candidate);
    if (!replaced.ok) return { applied: false, path: target.displayPath, message: replaced.message };
    mkdirSync(dirname(target.absPath), { recursive: true });
    writeFileSync(target.absPath, `${replaced.updated.trimEnd()}\n`, "utf8");
    return { applied: true, path: target.displayPath, message: `Updated existing rule for ${record.id} in ${target.displayPath}` };
  }
  if (current.includes(record.draft.proposedText)) return { applied: false, path: target.displayPath, message: "Rule already exists; not duplicated." };
  const withSection = ensureAgentLearningsSection(current);
  const updated = withSection.replace(/^## Agent Learnings\s*$/m, `## Agent Learnings\n${record.draft.proposedText}`);
  mkdirSync(dirname(target.absPath), { recursive: true });
  writeFileSync(target.absPath, `${updated.trimEnd()}\n`, "utf8");
  return { applied: true, path: target.displayPath, message: `Applied ${record.id} to ${target.displayPath}` };
}

export function previewRepoAgentsRule(root: string, record: LearningRecord): ApplyResult {
  return previewLearningRule(root, record);
}

export function applyRepoAgentsRule(root: string, record: LearningRecord): ApplyResult {
  return applyLearningRule(root, record);
}
