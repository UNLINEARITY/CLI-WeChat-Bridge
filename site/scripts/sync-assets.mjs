import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(siteDir, "../..");
const sourceDir = path.join(rootDir, "docs", "images");
const realDir = path.join(siteDir, "../public/assets/real");
const generatedDir = path.join(siteDir, "../public/assets/generated");
const iconDir = path.join(siteDir, "../public/assets/icons");

// Only the assets the page actually renders, resized to roughly 2x display size.
const rasterTargets = [
  { file: "logo.png", to: "logo.png", width: 1400, format: "png" },
  { file: "image-9.png", to: "image-9.webp", width: 1200, format: "webp" },
  { file: "image-10.png", to: "image-10.webp", width: 1200, format: "webp" },
  { file: "image-12.png", to: "image-12.webp", width: 1200, format: "webp" },
  { file: "image-13.png", to: "image-13.webp", width: 1800, format: "webp" },
];

function resetDir(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

function report(source, target) {
  const before = fs.statSync(source).size;
  const after = fs.statSync(target).size;
  console.log(`${path.basename(source)} ${(before / 1024).toFixed(0)}KB -> ${path.basename(target)} ${(after / 1024).toFixed(0)}KB`);
}

resetDir(realDir);
resetDir(generatedDir);

for (const { file, to, width, format } of rasterTargets) {
  const source = path.join(sourceDir, file);
  const target = path.join(realDir, to);
  let pipeline = sharp(source).resize({ width, withoutEnlargement: true });
  if (format === "webp") pipeline = pipeline.webp({ quality: 85 });
  else pipeline = pipeline.png({ compressionLevel: 9 });
  await pipeline.toFile(target);
  report(source, target);
}

// Re-encode the demo animation; fall back to a plain copy if sharp cannot process it.
const animationSource = path.join(sourceDir, "animation.webp");
const animationTarget = path.join(realDir, "animation.webp");
try {
  await sharp(animationSource, { animated: true }).resize({ width: 1500, withoutEnlargement: true }).webp({ quality: 78 }).toFile(animationTarget);
  report(animationSource, animationTarget);
} catch (error) {
  console.warn(`animation re-encode failed, copying original: ${error.message}`);
  fs.copyFileSync(animationSource, animationTarget);
}

// Favicon rasters from the brand mark.
for (const { size, name } of [{ size: 32, name: "favicon-32.png" }, { size: 180, name: "apple-touch-icon.png" }, { size: 512, name: "favicon-512.png" }]) {
  await sharp(path.join(iconDir, "favicon.svg")).resize({ width: size, height: size }).png().toFile(path.join(generatedDir, name));
}

// 1200x630 social card: brand background + wordmark + screenshot, graphics only
// (no text rasterization, so CI hosts without CJK fonts stay safe).
const ogWidth = 1200;
const ogHeight = 630;
const background = Buffer.from(
  `<svg width="${ogWidth}" height="${ogHeight}"><rect width="${ogWidth}" height="${ogHeight}" fill="#f4f5ef"/><rect x="36" y="36" width="${ogWidth - 72}" height="${ogHeight - 72}" rx="20" fill="none" stroke="#087c52" stroke-opacity=".35" stroke-width="3"/></svg>`,
);
const wordmark = await sharp(path.join(sourceDir, "logo.png")).resize({ width: 520 }).png().toBuffer();
const wordmarkMeta = await sharp(wordmark).metadata();
const screenshot = await sharp(path.join(sourceDir, "image-10.png"))
  .resize({ width: 400 })
  .extend({ top: 10, bottom: 10, left: 10, right: 10, background: { r: 255, g: 255, b: 255, alpha: 1 } })
  .png()
  .toBuffer();
const screenshotMeta = await sharp(screenshot).metadata();
const wordmarkTop = 68;
const screenshotTop = Math.max(wordmarkTop + wordmarkMeta.height + 44, Math.round((ogHeight - screenshotMeta.height) / 2));
await sharp(background)
  .composite([
    { input: wordmark, top: wordmarkTop, left: Math.round((ogWidth - wordmarkMeta.width) / 2) },
    { input: screenshot, top: screenshotTop, left: Math.round((ogWidth - screenshotMeta.width) / 2) },
  ])
  .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
  .toFile(path.join(generatedDir, "og-image.jpg"));
console.log(`og-image.jpg composed at ${ogWidth}x${ogHeight}`);
