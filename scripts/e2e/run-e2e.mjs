#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to its users.
//
// End-to-end runner over the local loopback channel. It starts a
// `--channel local` daemon in a stable workspace, hosts the real visible CLI
// in a PTY through scripts/e2e/visible-host.mjs, drives the seven minimal
// verification scenarios, and asserts on the loopback transcript.
//
// Usage:
//   node scripts/e2e/run-e2e.mjs [--adapter claude] [--only ids] [--keep]
//                                [--fresh-workspace] [--turn-timeout-ms N]
//
// Scenarios: send, terminal-send, resume, resume-send, resume-terminal,
// model, plan. Real CLI runs make real LLM calls.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

const REPO = path.resolve(import.meta.dirname, "..", "..");

const options = {
  adapter: "claude",
  only: null,
  keep: false,
  freshWorkspace: false,
  turnTimeoutMs: 240_000,
  commandTimeoutMs: 90_000,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const next = process.argv[i + 1];
  if (arg === "--adapter") {
    options.adapter = next;
    i += 1;
  } else if (arg === "--only") {
    options.only = new Set((next ?? "").split(",").map((id) => id.trim()).filter(Boolean));
    i += 1;
  } else if (arg === "--keep") {
    options.keep = true;
  } else if (arg === "--no-mirror") {
    options.noMirror = true;
  } else if (arg === "--fresh-workspace") {
    options.freshWorkspace = true;
  } else if (arg === "--turn-timeout-ms") {
    options.turnTimeoutMs = Number(next);
    i += 1;
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!["claude", "codex", "opencode", "pi"].includes(options.adapter)) {
  console.error(`Unsupported adapter for e2e: ${options.adapter}`);
  process.exit(1);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workspace = path.join(os.homedir(), ".cli-bridge-e2e", options.adapter === "claude" ? "workspace" : `workspace-${options.adapter}`);
if (options.freshWorkspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}
fs.mkdirSync(workspace, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-data-${options.adapter}-`));
const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-control-${options.adapter}-`));

const daemonEnv = {
  ...process.env,
  CLI_BRIDGE_DATA_DIR: dataDir,
  CLI_BRIDGE_VISIBLE_LAUNCHER: path.join(REPO, "scripts", "e2e", "visible-host.mjs"),
  CLI_BRIDGE_E2E_CONTROL_DIR: controlDir,
  CLI_BRIDGE_E2E_WORKSPACE: workspace,
  NO_PROXY: "127.0.0.1,localhost,::1",
};

console.log(`[e2e] adapter=${options.adapter} workspace=${workspace}`);
console.log(`[e2e] dataDir=${dataDir}`);
console.log(`[e2e] controlDir=${controlDir}`);

const daemon = spawn(process.execPath, [
  "--no-warnings",
  "--experimental-strip-types",
  path.join(REPO, "src", "daemon", "wechat-daemon.ts"),
  "--cwd", workspace,
  "--channel", "local",
  "--adapter", options.adapter,
], { env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
let daemonStderr = "";
daemon.stderr.on("data", (chunk) => { daemonStderr += chunk; });
daemon.stdout.on("data", () => {});

let endpoint = null;
let inboxFile = "";
let transcriptFile = "";

function readTranscriptRecords() {
  if (!transcriptFile || !fs.existsSync(transcriptFile)) return [];
  return fs.readFileSync(transcriptFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

let transcriptCursor = 0;
function nextOutbound(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const records = readTranscriptRecords();
      while (transcriptCursor < records.length) {
        const record = records[transcriptCursor];
        transcriptCursor += 1;
        if (record.direction === "outbound" && predicate(record)) {
          resolve(record);
          return;
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function inject(text) {
  fs.appendFileSync(inboxFile, `${JSON.stringify({ text })}\n`, "utf8");
}

function injectMarker(marker) {
  inject(`Reply with exactly: ${marker} and nothing else.`);
}

// --- PTY control client -----------------------------------------------------

let controlSocket = null;
const controlQueue = [];

function connectControl() {
  const socketPath = path.join(controlDir, `${options.adapter}.sock`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      controlSocket = socket;
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function controlWrite(data) {
  if (!controlSocket) throw new Error("PTY control socket is not connected.");
  controlSocket.write(`${JSON.stringify({ type: "write", data })}\n`);
}

function typeTerminal(text) {
  controlWrite(text);
  controlWrite("\r");
}

async function screenText() {
  const logPath = path.join(controlDir, `${options.adapter}.output.log`);
  if (!fs.existsSync(logPath)) return "";
  const stat = fs.statSync(logPath);
  const fd = fs.openSync(logPath, "r");
  const length = Math.min(stat.size, 256 * 1024);
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, stat.size - length);
  fs.closeSync(fd);
  const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 400, allowProposedApi: true });
  await new Promise((resolve) => {
    terminal.write(buffer.toString("utf8"), resolve);
  });
  let text = "";
  const active = terminal.buffer.active;
  for (let row = 0; row < active.length; row += 1) {
    const line = active.getLine(row);
    if (line) text += `${line.translateToString(true)}\n`;
  }
  return text;
}

async function waitForVisibleReady() {
  // Connect to the control socket as soon as the visible host creates it, then
  // dismiss first-run dialogs (theme picker, folder trust) until the CLI shows
  // an input prompt.
  for (let i = 0; i < 150 && !controlSocket; i += 1) {
    try {
      await connectControl();
    } catch {
      await delay(200);
    }
  }
  if (!controlSocket) throw new Error("Visible client control socket never appeared.");

  const startedAt = Date.now();
  let lastAction = 0;
  while (Date.now() - startedAt < 180_000) {
    const screen = await screenText();
    if (/❯/.test(screen)) return;
    const elapsed = Date.now() - lastAction;
    if (elapsed > 2_000) {
      if (/Choose theme|选择主题/i.test(screen) || /Do you trust|信任此文件夹|trust the files/i.test(screen)) {
        console.log("[e2e] dismissing a first-run dialog (Enter)");
        controlWrite("\r");
        lastAction = Date.now();
      } else if (/tips|提示/i.test(screen) && !/❯/.test(screen)) {
        controlWrite("\r");
        lastAction = Date.now();
      }
    }
    await delay(500);
  }
  throw new Error("Visible CLI never reached an input prompt. Last screen:\n" + (await screenText()).slice(-1200));
}

function shellQuote(value) {
  return /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function openMirrorWindow(socketPath) {
  if (process.platform !== "darwin") {
    console.log(`[e2e] mirror (non-macOS): tail -f ${path.join(controlDir, `${options.adapter}.output.log`)}`);
    return;
  }
  const command = [process.execPath, path.join(REPO, "scripts", "e2e", "mirror-view.mjs"), socketPath]
    .map(shellQuote)
    .join(" ");
  const script = `tell application "Terminal" to do script "${command}"`;
  const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`[e2e] mirror window opened (${options.adapter})`);
  console.log(`[e2e] mirror fallback: tail -f ${path.join(controlDir, `${options.adapter}.output.log`)}`);
}

async function waitDaemonReady() {
  const endpointFile = path.join(dataDir, "daemon-endpoint.json");
  for (let i = 0; i < 150 && !endpoint; i += 1) {
    try {
      endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    } catch {
      await delay(200);
    }
  }
  if (!endpoint) throw new Error(`Daemon endpoint never appeared.\n${daemonStderr.slice(-2000)}`);

  const workspacesDir = path.join(dataDir, "workspaces");
  for (let i = 0; i < 150 && !transcriptFile; i += 1) {
    try {
      const key = fs.readdirSync(workspacesDir)[0];
      if (key) {
        inboxFile = path.join(workspacesDir, key, "local-inbox.jsonl");
        transcriptFile = path.join(workspacesDir, key, "local-transcript.jsonl");
        if (!fs.existsSync(transcriptFile)) {
          transcriptFile = "";
          inboxFile = "";
        }
      }
    } catch {
      // Not ready yet.
    }
    if (!transcriptFile) await delay(200);
  }
  if (!transcriptFile) throw new Error(`Workspace transcript never appeared.\n${daemonStderr.slice(-2000)}`);

  await nextOutbound(() => true, 120_000, "daemon welcome");
}

function requestDaemon(payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.port, "127.0.0.1");
    socket.setNoDelay(true);
    const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let buffer = "";
    const finish = (error, result) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, token: endpoint.token, payload })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let frame;
      try {
        frame = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error("Invalid daemon IPC response."));
        return;
      }
      if (frame.error) finish(new Error(frame.error));
      else finish(null, frame.result);
    });
    socket.on("error", (error) => finish(error));
    setTimeout(() => finish(new Error("Daemon IPC request timed out.")), timeoutMs).unref();
  });
}

async function shutdown() {
  try { controlSocket?.write(`${JSON.stringify({ type: "kill" })}\n`); } catch { /* already gone */ }
  try { await requestDaemon({ command: "shutdown" }, 8_000); } catch { /* daemon may already be gone */ }
  daemon.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => daemon.once("exit", resolve)),
    delay(10_000).then(() => daemon.kill("SIGKILL")),
  ]);
  if (!options.keep) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(controlDir, { recursive: true, force: true });
  } else {
    console.log(`[e2e] kept dataDir=${dataDir} controlDir=${controlDir}`);
  }
}

// --- Scenarios ---------------------------------------------------------------

const markerFor = (id) => `E2E-${options.adapter.toUpperCase()}-OK-${id}`;

let resumeTargetNumber = null;

function parseResumeTargetNumber(listText) {
  for (const line of listText.split("\n")) {
    const match = /^(\d+)\..+/.exec(line.trim());
    if (match && !line.includes("[current]")) {
      return Number(match[1]);
    }
  }
  return null;
}

const scenarios = [
  {
    id: "send",
    name: "one remote prompt reaches a final reply",
    async run() {
      injectMarker(markerFor(1));
      await nextOutbound((record) => record.context === "final_reply" && record.text.includes(markerFor(1)), options.turnTimeoutMs, "final reply for send");
    },
  },
  {
    id: "terminal-send",
    name: "a prompt typed in the visible CLI is mirrored and answered",
    async run() {
      typeTerminal(`Reply with exactly: ${markerFor(2)} and nothing else.`);
      await nextOutbound((record) => record.context === "mirrored_user_input" && record.text.includes(markerFor(2)), options.turnTimeoutMs, "mirrored local input");
      await nextOutbound((record) => record.context === "final_reply" && record.text.includes(markerFor(2)), options.turnTimeoutMs, "final reply for terminal send");
    },
  },
  {
    id: "resume",
    name: "/resume lists recent sessions and a real switch target is available",
    async run() {
      inject("/resume");
      const list = await nextOutbound(
        (record) => record.context === "message" && /Recent .*sessions:|No saved .*sessions/.test(record.text),
        options.commandTimeoutMs,
        "resume session list",
      );
      resumeTargetNumber = parseResumeTargetNumber(list.text);
      if (!resumeTargetNumber) {
        // Only the current session exists. Start a fresh one inside the TUI
        // with Claude's native /clear so the next scenario can perform a
        // real switch back to this session.
        typeTerminal("/clear");
        await nextOutbound(
          (record) => /switched to \S+ from the local terminal/.test(record.text),
          options.turnTimeoutMs,
          "local session switch after /clear",
        );
        inject("/resume");
        const nextList = await nextOutbound(
          (record) => record.context === "message" && /Recent .*sessions:|No saved .*sessions/.test(record.text),
          options.commandTimeoutMs,
          "resume session list after /clear",
        );
        resumeTargetNumber = parseResumeTargetNumber(nextList.text);
      }
      if (!resumeTargetNumber) {
        throw new Error("No non-current session is available for a real resume switch.");
      }
    },
  },
  {
    id: "resume-send",
    name: "/resume really switches back and a remote prompt still reaches a final reply",
    async run() {
      inject(`/resume ${resumeTargetNumber ?? 1}`);
      await nextOutbound(
        (record) => /switched to \S+ from WeChat/.test(record.text),
        options.commandTimeoutMs,
        "real resume switch",
      );
      injectMarker(markerFor(4));
      await nextOutbound((record) => record.context === "final_reply" && record.text.includes(markerFor(4)), options.turnTimeoutMs, "final reply after resume");
    },
  },
  {
    id: "resume-terminal",
    name: "after /resume, a terminal prompt is still mirrored and answered",
    async run() {
      typeTerminal(`Reply with exactly: ${markerFor(5)} and nothing else.`);
      await nextOutbound((record) => record.context === "mirrored_user_input" && record.text.includes(markerFor(5)), options.turnTimeoutMs, "mirrored input after resume");
      await nextOutbound((record) => record.context === "final_reply" && record.text.includes(markerFor(5)), options.turnTimeoutMs, "final reply after resume terminal send");
    },
  },
  {
    id: "model",
    name: "/model lists models and switches to selection 1",
    async run() {
      inject("/model");
      await nextOutbound(
        (record) => /Available .* models:|did not return any available models/.test(record.text),
        options.commandTimeoutMs,
        "model list",
      );
      inject("/model 1");
      await nextOutbound(
        (record) => /model switched to|did not change/.test(record.text),
        options.turnTimeoutMs,
        "model switch confirmation",
      );
    },
  },
  {
    id: "plan",
    name: "/plan toggles plan mode on and off",
    async run() {
      inject("/plan");
      await nextOutbound((record) => /plan mode enabled/.test(record.text), options.commandTimeoutMs, "plan enabled notice");
      inject("/plan off");
      await nextOutbound((record) => /plan mode disabled/.test(record.text), options.commandTimeoutMs, "plan disabled notice");
    },
  },
];

async function main() {
  const results = [];
  try {
    await waitDaemonReady();
    console.log("[e2e] daemon ready on the local channel");
    // The bridge reports "interactive session ready" slightly after the TUI
    // paints its prompt; remote commands sent before that are rejected with
    // "must be idle". Wait for the bridge-side session follow event first.
    await nextOutbound(
      (record) => /switched to \S+ from the local terminal/.test(record.text),
      120_000,
      "bridge-side session readiness",
    );
    await waitForVisibleReady();
    // Third readiness layer: the companion's native-control screen mirror
    // lags the freshly painted TUI. The authoritative signal is the adapter
    // reaching idle status; remote commands sent earlier are rejected with
    // "must be at an empty native prompt".
    const idleStartedAt = Date.now();
    while (Date.now() - idleStartedAt < 60_000) {
      let slot = null;
      try {
        const status = await requestDaemon({ command: "status" });
        slot = (status?.slots ?? []).find((entry) => entry.adapter === options.adapter) ?? null;
      } catch {
        // IPC hiccup; retry.
      }
      if (slot?.status === "idle") {
        await delay(500);
        break;
      }
      await delay(300);
    }
    console.log(`[e2e] visible ${options.adapter} CLI ready in the PTY host`);
    if (!options.noMirror) {
      openMirrorWindow(path.join(controlDir, `${options.adapter}.sock`));
    }

    for (const scenario of scenarios) {
      if (options.only && !options.only.has(scenario.id)) continue;
      const startedAt = Date.now();
      process.stdout.write(`[e2e] scenario ${scenario.id}: ${scenario.name} ... `);
      try {
        await scenario.run();
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`PASS (${seconds}s)`);
        results.push({ id: scenario.id, ok: true });
      } catch (error) {
        console.log(`FAIL\n  ${error instanceof Error ? error.message : String(error)}`);
        results.push({ id: scenario.id, ok: false, error: String(error) });
        break;
      }
    }
  } catch (error) {
    console.error(`[e2e] harness failure: ${error instanceof Error ? error.message : String(error)}`);
    if (daemonStderr) console.error(daemonStderr.slice(-1500));
    results.push({ id: "harness", ok: false, error: String(error) });
  } finally {
    await shutdown();
  }

  console.log("\n[e2e] summary");
  for (const result of results) {
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.id}`);
  }
  const failed = results.some((result) => !result.ok);
  if (failed && options.keep) {
    if (transcriptFile && fs.existsSync(transcriptFile)) {
      console.log(`[e2e] transcript tail:\n${fs.readFileSync(transcriptFile, "utf8").split("\n").slice(-12).join("\n")}`);
    }
    console.log(`[e2e] screen tail:\n${(await screenText()).slice(-800)}`);
    const bridgeLog = path.join(dataDir, "bridge.log");
    if (fs.existsSync(bridgeLog)) {
      console.log(`[e2e] bridge.log tail:\n${fs.readFileSync(bridgeLog, "utf8").split("\n").slice(-25).join("\n")}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
