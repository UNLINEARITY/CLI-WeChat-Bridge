import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveChannelDataDir } from "../wechat/channel-config.ts";

const OK = "✓";
const FAIL = "✗";

function findExecutable(name: string): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(cmd, [name], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim().split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

function getPlatformPtyFix(): string {
  switch (process.platform) {
    case "linux":
      return "sudo apt install build-essential python3 && npm install -g cli-wechat-bridge@latest";
    case "darwin":
      return "xcode-select --install && npm rebuild node-pty";
    case "win32":
      return "npm rebuild node-pty (also ensure Visual C++ Redistributable is installed)";
    default:
      return "npm rebuild node-pty";
  }
}

export async function runDoctorCheck(): Promise<void> {
  const lines: string[] = [];
  lines.push("CLI WeChat Bridge — Environment Check");
  lines.push("=".repeat(38));
  lines.push("");

  // Node.js
  lines.push(`Node.js:     ${process.version}  ${OK}`);
  lines.push(`Platform:    ${process.platform}-${process.arch}`);

  // Windows build number
  if (process.platform === "win32") {
    const release = os.release();
    const build = parseInt(release.split(".").pop() ?? "0", 10);
    const ok = build >= 18309;
    lines.push(`Win Build:   ${build}  ${ok ? OK : FAIL + " (ConPTY requires build 18309+)"}`);
  }

  lines.push("");

  // node-pty
  try {
    await import("node-pty");
    lines.push(`node-pty:    ${OK} loaded`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const short = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
    lines.push(`node-pty:    ${FAIL} ${short}`);
    lines.push(`             Fix: ${getPlatformPtyFix()}`);
  }

  lines.push("");

  // CLI availability
  const clis: Array<{ name: string; label: string; optional: boolean }> = [
    { name: "codex", label: "Codex CLI", optional: true },
    { name: "claude", label: "Claude CLI", optional: true },
    { name: "opencode", label: "OpenCode", optional: true },
  ];

  for (const cli of clis) {
    const loc = findExecutable(cli.name);
    if (loc) {
      lines.push(`${cli.label.padEnd(12)} ${OK} ${loc}`);
    } else {
      lines.push(`${cli.label.padEnd(12)} ${FAIL} not found${cli.optional ? " (optional)" : ""}`);
    }
  }

  lines.push("");

  // Data directory
  const dataDir = resolveChannelDataDir();
  const dataDirExists = fs.existsSync(dataDir);
  lines.push(`Data dir:    ${dataDir}  ${dataDirExists ? OK : FAIL + " (will be created on first run)"}`);

  // Credentials
  const credFile = path.join(dataDir, "account.json");
  const credExists = fs.existsSync(credFile);
  lines.push(`Credentials: ${credExists ? OK + " found" : FAIL + " not found (run wechat-setup first)"}`);

  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}
