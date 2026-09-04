const root = document.documentElement;
const body = document.body;
function setLanguage(language) {
  const next = language === "en" ? "en" : "zh";
  root.lang = next === "en" ? "en" : "zh-CN";
  body.dataset.activeLang = next;
  document.querySelectorAll("[data-lang]").forEach((element) => {
    const active = element.dataset.lang === next;
    element.hidden = !active;
  });
  const toggle = document.querySelector("[data-lang-toggle]");
  if (toggle) {
    toggle.textContent = next === "en" ? "中" : "EN";
    toggle.setAttribute("aria-label", next === "en" ? "切换中文" : "Switch to English");
  }
  localStorage.setItem("cli-bridge-site-lang", next);
  const url = new URL(window.location.href);
  if (next === "en") url.searchParams.set("lang", "en");
  else url.searchParams.delete("lang");
  window.history.replaceState({}, "", url);
}

const requestedLanguage = new URLSearchParams(window.location.search).get("lang");
const savedLanguage = localStorage.getItem("cli-bridge-site-lang");
setLanguage(requestedLanguage === "en" || savedLanguage === "en" ? "en" : "zh");

document.querySelector("[data-lang-toggle]")?.addEventListener("click", () => {
  setLanguage(body.dataset.activeLang === "en" ? "zh" : "en");
});

document.querySelector("[data-menu-toggle]")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  const nav = document.querySelector(".desktop-nav");
  const isOpen = nav?.classList.toggle("is-open") ?? false;
  button.setAttribute("aria-expanded", String(isOpen));
});

document.querySelectorAll(".desktop-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelector(".desktop-nav")?.classList.remove("is-open");
    document.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
  });
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const original = button.dataset.copyLabel || button.textContent;
    try {
      await copyText(button.dataset.copy || "");
      button.dataset.copyLabel = original;
      if (button.hasAttribute("data-copy-label")) {
        button.textContent = body.dataset.activeLang === "en" ? "Copied" : "已复制";
      } else {
        button.textContent = "copied";
      }
      window.setTimeout(() => {
        button.textContent = original;
      }, 1500);
    } catch {
      button.textContent = body.dataset.activeLang === "en" ? "Copy failed" : "复制失败";
      window.setTimeout(() => { button.textContent = original; }, 1500);
    }
  });
});

document.querySelectorAll("[data-command-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.commandTab;
    document.querySelectorAll("[data-command-tab]").forEach((item) => item.classList.toggle("is-active", item === tab));
    document.querySelectorAll("[data-command-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.commandPanel !== target;
    });
  });
});

const revealItems = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries, instance) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        instance.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px" });
  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());
