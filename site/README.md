# CLI WeChat Bridge Product Site

This directory contains the standalone Astro site published to GitHub Pages.

```bash
npm install
npm run dev
npm run build
```

## Asset pipeline

Both `dev` and `build` first run `scripts/sync-assets.mjs`, which uses [sharp](https://sharp.pixelplumbing.com/) to turn the source images in `../docs/images` into deploy-ready assets:

- `logo.png` is downscaled and the proof screenshots (`image-10/12/13.png`) are converted to WebP at roughly 2x display size.
- `animation.webp` is re-encoded as an animated WebP (falls back to a plain copy if sharp cannot process it).
- `favicon.svg` (in `public/assets/icons/`) is rasterized into the PNG favicons.
- A 1200x630 `og-image.jpg` social card is composed from the brand background, wordmark, and a screenshot — graphics only, no text rasterization, so CI hosts without CJK fonts stay safe.

Outputs land in the ignored `public/assets/real/` and `public/assets/generated/` directories; nothing there is committed. `scripts/fetch-metrics.mjs` then writes `public/assets/generated/metrics.json` (GitHub stars, npm version and weekly downloads; pass `SITE_GITHUB_TOKEN` to raise the GitHub API rate limit, the Pages workflow does this via the built-in `GITHUB_TOKEN`).

The page renders Chinese copy from the `zh` object in `src/pages/index.astro`; adding another language means adding one sibling object there.
