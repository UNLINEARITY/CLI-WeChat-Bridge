import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { CHANNEL_DATA_DIR, ensureChannelDataDir } from "../wechat/channel-config.ts";

const UPDATE_CHECK_FILE = path.join(CHANNEL_DATA_DIR, "update-check.json");
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24小时

export interface UpdateCheckCache {
  lastCheck: string;
  lastNotifiedVersion: string;
}

export interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

/**
 * 使用 git 命令获取远程仓库最新版本号
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    // 尝试使用 git ls-remote 获取所有 tags
    const tagsOutput = execSync('git ls-remote --tags origin', {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });

    if (!tagsOutput) {
      return null;
    }

    // 解析 tags，找到版本号格式（如 0.1.0, 0.2.0 等）
    const versionTags = tagsOutput
      .split('\n')
      .filter(line => {
        // 匹配 refs/tags/0.5.0 格式（不是 v0.5.0）
        return line.includes('refs/tags/') &&
               !line.includes('^{}') &&
               /^\w+\s+refs\/tags\/\d+\.\d+\.\d+$/.test(line);
      })
      .map(line => {
        const match = line.match(/refs\/tags\/(\d+\.\d+\.\d+)$/);
        return match ? match[1] : null;
      })
      .filter((v): v is string => v !== null);

    if (versionTags.length === 0) {
      return null;
    }

    // 按版本号排序，返回最新的
    versionTags.sort((a, b) => compareVersions(b, a));
    return versionTags[0] ?? null;
  } catch (error) {
    // 如果 git 命令失败，静默返回 null
    return null;
  }
}

/**
 * 从本地 package.json 读取当前版本
 */
export async function getCurrentVersion(): Promise<string> {
  const packageJsonPath = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "package.json"
  );

  try {
    const content = await fs.promises.readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(content);
    return packageJson.version || "0.0.0";
  } catch (error) {
    return "0.0.0";
  }
}

/**
 * 读取更新检查缓存
 */
function readUpdateCache(): UpdateCheckCache | null {
  try {
    if (!fs.existsSync(UPDATE_CHECK_FILE)) {
      return null;
    }

    const content = fs.readFileSync(UPDATE_CHECK_FILE, "utf-8");
    return JSON.parse(content) as UpdateCheckCache;
  } catch (error) {
    return null;
  }
}

/**
 * 写入更新检查缓存
 */
function writeUpdateCache(cache: UpdateCheckCache): void {
  try {
    ensureChannelDataDir();
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify(cache, null, 2));
  } catch (error) {
    // 静默失败，不影响正常使用
  }
}

/**
 * 比较两个版本号
 * @returns 返回值 > 0 表示 version1 更新，< 0 表示 version2 更新，= 0 表示相等
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}

/**
 * 检查是否有新版本可用
 * @param forceCheck 是否强制检查（忽略缓存）
 */
export async function checkForUpdate(
  forceCheck = false
): Promise<VersionInfo | null> {
  const currentVersion = await getCurrentVersion();

  // 检查缓存
  if (!forceCheck) {
    const cache = readUpdateCache();
    if (cache) {
      const lastCheckTime = new Date(cache.lastCheck).getTime();
      const now = Date.now();

      // 如果缓存未过期（24小时内），且已经通知过最新版本
      if (now - lastCheckTime < CACHE_DURATION_MS) {
        // 如果缓存的版本与当前版本一致，说明已经通知过
        if (cache.lastNotifiedVersion === currentVersion) {
          return null;
        }
      }
    }
  }

  // 从 GitHub 获取最新版本
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    return null;
  }

  // 比较版本
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  // 更新缓存
  writeUpdateCache({
    lastCheck: new Date().toISOString(),
    lastNotifiedVersion: currentVersion,
  });

  return {
    current: currentVersion,
    latest: latestVersion,
    hasUpdate,
  };
}

/**
 * 格式化更新提示信息
 */
export function formatUpdateMessage(versionInfo: VersionInfo): string {
  const { current, latest } = versionInfo;

  return `
[Update Available] Version ${latest} is available (current: ${current})

Update instructions:
   cd CLI-WeChat-Bridge
   git pull
   bun install
   npm install -g .

For more information:
   https://github.com/UNLINEARITY/CLI-WeChat-Bridge/releases
`;
}
