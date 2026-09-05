import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const siteDir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(siteDir, "../public/assets/generated/metrics.json");
const fallback = { stars: null, npmVersion: "1.1.7", downloads: null, updatedAt: new Date().toISOString() };
async function json(url) { const response = await fetch(url, { signal: AbortSignal.timeout(3500), headers: { "user-agent": "cli-wechat-bridge-pages" } }); if (!response.ok) throw new Error(String(response.status)); return response.json(); }
try {
  const [repo, npm, downloads] = await Promise.all([
    json("https://api.github.com/repos/UNLINEARITY/CLI-WeChat-Bridge"),
    json("https://registry.npmjs.org/cli-wechat-bridge/latest"),
    json("https://api.npmjs.org/downloads/point/last-week/cli-wechat-bridge"),
  ]);
  Object.assign(fallback, { stars: repo.stargazers_count ?? null, npmVersion: npm.version ?? fallback.npmVersion, downloads: downloads.downloads ?? null });
} catch { /* keep build reliable when APIs are unavailable */ }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fallback, null, 2));
