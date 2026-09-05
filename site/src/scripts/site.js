const root = document.documentElement;
// 隐藏初始态仅在脚本加载后启用（.js.io 前缀），脚本加载失败时内容直接可见。
root.classList.add("io");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const ease = (t) => t * t * (3 - 2 * t);

const header = document.querySelector(".site-nav");
const nav = document.querySelector(".site-nav nav");
const menu = document.querySelector("[data-menu-toggle]");
menu?.addEventListener("click", () => { const open = !nav?.classList.contains("is-open"); nav?.classList.toggle("is-open", open); menu.setAttribute("aria-expanded", String(open)); });
document.querySelectorAll(".site-nav nav a").forEach((link) => link.addEventListener("click", () => nav?.classList.remove("is-open")));
function syncHeader() { header?.classList.toggle("is-scrolled", scrollY > 10); }
syncHeader();
addEventListener("scroll", syncHeader, { passive: true });

const navLinks = [...document.querySelectorAll(".site-nav nav a")];
if ("IntersectionObserver" in window && navLinks.length) {
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      navLinks.forEach((link) => link.classList.toggle("is-active", link.hash === `#${entry.target.id}`));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  ["how", "adapters"].forEach((id) => { const section = document.getElementById(id); if (section) spy.observe(section); });
}

async function copyText(value) { if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value); const input = document.createElement("textarea"); input.value = value; input.style.position = "fixed"; input.style.opacity = "0"; document.body.append(input); input.select(); document.execCommand("copy"); input.remove(); }

document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => { try { await copyText(button.dataset.copy || ""); button.classList.add("copied"); } catch { button.classList.add("copy-failed"); } setTimeout(() => { button.classList.remove("copied", "copy-failed"); }, 1400); }));

// ---- 滚动驱动引擎：所有过渡动画与滚动位置一一对应、可恢复 ----
const revealUnits = [];
for (const container of document.querySelectorAll("[data-scrub-stagger]")) {
  [...container.children].forEach((child, index) => revealUnits.push({ el: child, delay: Math.min(0.48, index * 0.14) }));
}
document.querySelectorAll("[data-scrub]").forEach((el) => revealUnits.push({ el, delay: 0 }));

const heroBubbles = [...document.querySelectorAll(".art-phone .wechat-bubble")];
const termLines = [...document.querySelectorAll(".art-terminal .tl")];
const bigLogo = document.querySelector(".logo-big");
const navLogo = document.querySelector(".brand img");
const logoAnchor = document.querySelector(".logo-anchor");
const engineActive = !reduceMotion && Boolean(bigLogo && navLogo && logoAnchor);

function updateLogo() {
  if (!engineActive) return;
  const anchorRect = logoAnchor.getBoundingClientRect();
  const navRect = navLogo.getBoundingClientRect();
  const p = clamp01(scrollY / 520);
  const e = ease(p);
  const ax = anchorRect.left + anchorRect.width / 2;
  const ay = anchorRect.top + anchorRect.height / 2;
  const nx = navRect.left + navRect.width / 2;
  const ny = navRect.top + navRect.height / 2;
  const scale = 1 + (navRect.width / bigLogo.offsetWidth - 1) * e;
  bigLogo.style.transform = `translate(${((nx - ax) * e).toFixed(1)}px, ${((ny - ay) * e).toFixed(1)}px) scale(${scale.toFixed(4)})`;
  bigLogo.style.opacity = String(1 - clamp01((p - 0.85) / 0.15));
}

function updateReveals(vh) {
  for (const unit of revealUnits) {
    const rect = unit.el.getBoundingClientRect();
    const raw = clamp01((vh * 0.96 - rect.top) / (vh * 0.42));
    const p = ease(clamp01((raw - unit.delay) / (1 - unit.delay)));
    unit.el.style.opacity = p.toFixed(3);
    unit.el.style.transform = `translateY(${((1 - p) * 46).toFixed(1)}px) scale(${(0.965 + p * 0.035).toFixed(4)})`;
  }
}

function updateMock() {
  const hp = hpOverride ?? clamp01(scrollY / 620);
  heroBubbles.forEach((bubble, index) => bubble.classList.toggle("pop", hp >= index * 0.14));
  termLines.forEach((line, index) => line.classList.toggle("on", hp >= 0.08 + index * 0.13));
}

const metricEls = [...document.querySelectorAll("[data-metric]")];
const metricsSection = document.querySelector(".metrics");
let metricsData = null;
function applyMetrics(vh) {
  if (!metricsData || !metricsSection) return;
  const rect = metricsSection.getBoundingClientRect();
  const p = ease(clamp01((vh * 0.92 - rect.top) / (vh * 0.3)));
  metricEls.forEach((el) => {
    const value = metricsData[el.dataset.metric];
    if (typeof value === "number") el.textContent = Math.round(value * p).toLocaleString();
  });
}
fetch("./assets/generated/metrics.json").then((response) => response.json()).then((data) => {
  metricsData = data;
  metricEls.forEach((el) => {
    const value = data[el.dataset.metric];
    if (value === null || value === undefined) return;
    if (typeof value !== "number") el.textContent = value;
    else if (!engineActive) el.textContent = value.toLocaleString();
  });
}).catch(() => {});

let ticking = false;
function frame() {
  ticking = false;
  if (!engineActive) return;
  const vh = innerHeight;
  updateLogo();
  updateReveals(vh);
  updateMock();
  applyMetrics(vh);
}
function requestFrame() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
addEventListener("scroll", requestFrame, { passive: true });
addEventListener("resize", requestFrame);
requestFrame();

// 测试钩子:?scrub=N 直接滚到指定位置;?hp=F 强制 mock 进度,便于截图验证滚动映射。
const scrubParams = new URLSearchParams(location.search);
const scrubTarget = scrubParams.get("scrub");
const hpOverride = scrubParams.has("hp") ? Number(scrubParams.get("hp")) : null;
if (scrubTarget) { scrollTo(0, Number(scrubTarget) || 0); requestFrame(); }
