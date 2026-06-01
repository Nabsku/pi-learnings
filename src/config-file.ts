import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, DEFAULT_CONFIG } from "./config.ts";
import type { LearningLoopConfig } from "./config.ts";

function renderConfig(config: LearningLoopConfig = DEFAULT_CONFIG): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function initConfig(root: string): { created: boolean; path: string; message: string } {
  const path = configPath(root);
  if (existsSync(path)) return { created: false, path, message: `Config already exists: ${path}` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderConfig(), "utf8");
  return { created: true, path, message: `Created config: ${path}` };
}

export { renderConfig };
