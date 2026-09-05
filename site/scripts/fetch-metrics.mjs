import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const siteDir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(siteDir, "../public/assets/generated/metrics.json");
const fallback = { stars: null, npmVersion: null, downloads: null, updatedAt: new Date().toISOString() };
const token = process.env.SITE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
async function json(url) {
  const headers = { "user-agent": "cli-wechat-bridge-pages" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(6000), headers });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
const fetchQuietly = (url) => json(url).catch(() => null);

// npm 全历史下载量：range 接口按自然年分段求和（scoped 包名需 encode）。
async function totalDownloads(name) {
  const encoded = encodeURIComponent(name);
  const currentYear = new Date().getUTCFullYear();
  const years = [];
  for (let year = 2023; year <= currentYear; year++) years.push(year);
  const totals = await Promise.all(years.map(async (year) => {
    const from = `${year}-01-01`;
    const to = year === currentYear ? new Date().toISOString().slice(0, 10) : `${year}-12-31`;
    const data = await fetchQuietly(`https://api.npmjs.org/downloads/range/${from}:${to}/${encoded}`);
    if (!data?.downloads?.length) return null;
    return data.downloads.reduce((sum, day) => sum + day.downloads, 0);
  }));
  if (totals.every((value) => value === null)) return null;
  return totals.reduce((sum, value) => sum + (value ?? 0), 0);
}

const [repo, npm, unscopedTotal, scopedTotal] = await Promise.all([
  fetchQuietly("https://api.github.com/repos/UNLINEARITY/CLI-WeChat-Bridge"),
  fetchQuietly("https://registry.npmjs.org/cli-wechat-bridge/latest"),
  totalDownloads("cli-wechat-bridge"),
  totalDownloads("@unlinearity/cli-wechat-bridge"),
]);
if (repo?.stargazers_count != null) fallback.stars = repo.stargazers_count;
if (npm?.version) fallback.npmVersion = npm.version;
if (unscopedTotal !== null || scopedTotal !== null) fallback.downloads = (unscopedTotal ?? 0) + (scopedTotal ?? 0);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fallback, null, 2));
