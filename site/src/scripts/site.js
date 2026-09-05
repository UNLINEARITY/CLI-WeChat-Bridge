const root = document.documentElement;
const body = document.body;
function setLanguage(language) {
  const next = language === "en" ? "en" : "zh";
  root.lang = next === "en" ? "en" : "zh-CN";
  body.dataset.activeLang = next;
  document.querySelectorAll("[data-lang]").forEach((element) => { element.hidden = element.dataset.lang !== next; });
  const toggle = document.querySelector("[data-lang-toggle]");
  if (toggle) { toggle.textContent = next === "en" ? "中" : "EN"; toggle.setAttribute("aria-label", next === "en" ? "切换中文" : "Switch to English"); }
  localStorage.setItem("cli-bridge-site-lang", next);
}
const requested = new URLSearchParams(location.search).get("lang");
setLanguage(requested === "en" || localStorage.getItem("cli-bridge-site-lang") === "en" ? "en" : "zh");
document.querySelector("[data-lang-toggle]")?.addEventListener("click", () => setLanguage(body.dataset.activeLang === "en" ? "zh" : "en"));
const nav = document.querySelector(".site-nav nav");
const menu = document.querySelector("[data-menu-toggle]");
menu?.addEventListener("click", () => { const open = !nav?.classList.contains("is-open"); nav?.classList.toggle("is-open", open); menu.setAttribute("aria-expanded", String(open)); });
document.querySelectorAll(".site-nav nav a").forEach((link) => link.addEventListener("click", () => nav?.classList.remove("is-open")));
async function copyText(value) { if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value); const input = document.createElement("textarea"); input.value = value; input.style.position = "fixed"; input.style.opacity = "0"; document.body.append(input); input.select(); document.execCommand("copy"); input.remove(); }
document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => { const original = button.textContent; try { await copyText(button.dataset.copy || ""); button.textContent = "已复制"; } catch { button.textContent = "复制失败"; } setTimeout(() => { button.textContent = original; }, 1500); }));
const tabs = [...document.querySelectorAll("[data-command-tab]")];
function activate(tab) { const target = tab.dataset.commandTab; tabs.forEach((item) => { const active = item === tab; item.classList.toggle("is-active", active); item.setAttribute("aria-selected", String(active)); }); document.querySelectorAll("[data-command-panel]").forEach((panel) => { panel.hidden = panel.dataset.commandPanel !== target; }); }
tabs.forEach((tab) => { tab.addEventListener("click", () => activate(tab)); tab.addEventListener("keydown", (event) => { const index = tabs.indexOf(tab); const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : -1; if (next >= 0) { event.preventDefault(); tabs[next].focus(); activate(tabs[next]); } }); });
const items = document.querySelectorAll(".reveal"); items.forEach((item) => item.classList.add("is-visible")); if ("IntersectionObserver" in window) { const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) observer.unobserve(entry.target); }), { threshold: .12 }); items.forEach((item) => observer.observe(item)); }
fetch("./assets/generated/metrics.json").then((response) => response.json()).then((metrics) => { document.querySelectorAll("[data-metric]").forEach((element) => { const value = metrics[element.dataset.metric]; if (value !== null && value !== undefined) element.textContent = typeof value === "number" ? value.toLocaleString() : value; }); }).catch(() => {});

const demo = document.querySelector('[data-demo-trigger]'); demo?.addEventListener('click', () => { const phone = document.querySelector('.art-phone'); const terminal = document.querySelector('.art-terminal .ok'); phone?.classList.remove('demo-pulse'); void phone?.offsetWidth; phone?.classList.add('demo-pulse'); if (terminal) { const original = terminal.textContent; terminal.textContent = '✓ message received — running locally'; setTimeout(() => { terminal.textContent = original; }, 1800); } });
