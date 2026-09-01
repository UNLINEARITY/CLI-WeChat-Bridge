import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_INBOUND_MESSAGE_CLAIM_TTL_MS = 10 * 60 * 1000;

export function buildInboundMessageClaimPath(
  messageKey: string,
  claimsDir: string,
): string {
  const fileName = `${crypto.createHash("sha1").update(messageKey).digest("hex")}.json`;
  return path.join(claimsDir, fileName);
}

export function tryClaimChannelInboundMessage(
  messageKey: string,
  options: {
    claimsDir: string;
    nowMs?: number;
    ttlMs?: number;
  },
): boolean {
  if (!messageKey) {
    return false;
  }

  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_INBOUND_MESSAGE_CLAIM_TTL_MS;
  const claimPath = buildInboundMessageClaimPath(messageKey, options.claimsDir);

  const attemptClaim = (): boolean => {
    fs.mkdirSync(options.claimsDir, { recursive: true });
    const handle = fs.openSync(claimPath, "wx");
    try {
      fs.writeFileSync(
        handle,
        JSON.stringify(
          {
            key: messageKey,
            claimedAt: new Date(nowMs).toISOString(),
            pid: process.pid,
          },
          null,
          2,
        ),
        "utf-8",
      );
    } finally {
      fs.closeSync(handle);
    }
    return true;
  };

  try {
    return attemptClaim();
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";
    if (code !== "EEXIST") {
      return false;
    }
  }

  try {
    const stat = fs.statSync(claimPath);
    if (Number.isFinite(stat.mtimeMs) && nowMs - stat.mtimeMs > ttlMs) {
      fs.rmSync(claimPath, { force: true });
      return attemptClaim();
    }
  } catch {
    try {
      return attemptClaim();
    } catch {
      return false;
    }
  }

  return false;
}
