import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isDirectModuleRun(
  importMetaUrl: string,
  argv: string[] = process.argv,
  importMetaMain?: boolean,
): boolean {
  if (typeof importMetaMain === "boolean") {
    return importMetaMain;
  }
  const entryPath = argv[1];
  if (!entryPath) {
    return false;
  }
  return normalizeComparablePath(fileURLToPath(importMetaUrl)) ===
    normalizeComparablePath(entryPath);
}
