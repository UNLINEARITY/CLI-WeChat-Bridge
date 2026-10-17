const root = document.documentElement;
const body = document.body;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
const copyFeedback = body.dataset.copySuccess || "Copied";
const base = body.dataset.base || "/";
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const range = (value, from, to) => clamp01((value - from) / (to - from));

const header = document.querySelector(".site-nav");
const nav = document.querySelector(".site-nav nav");
const menu = document.querySelector("[data-menu-toggle]");

function setMenu(open) {
  nav?.classList.toggle("is-open", open);
  menu?.setAttribute("aria-expanded", String(open));
}
menu?.addEventListener("click", () => setMenu(!nav?.classList.contains("is-open")));
document.querySelectorAll(".site-nav nav a").forEach((link) => link.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") setMenu(false); });
document.addEventListener("pointerdown", (event) => {
  if (nav?.classList.contains("is-open") && !header?.contains(event.target)) setMenu(false);
});

function syncHeader() { header?.classList.toggle("is-scrolled", scrollY > 8); }
syncHeader();

const navLinks = [...document.querySelectorAll(".site-nav nav a")];
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      navLinks.forEach((link) => link.classList.toggle("is-active", link.hash === `#${entry.target.id}`));
    }
  }, { rootMargin: "-42% 0px -52% 0px" });
  navLinks.forEach((link) => {
    const section = document.querySelector(link.hash);
    if (section) observer.observe(section);
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function showCopied(button) {
  button.dataset.feedback = copyFeedback;
  button.classList.add("copied");
  setTimeout(() => button.classList.remove("copied"), 1400);
}
document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  try { await copyText(button.dataset.copy || ""); showCopied(button); } catch {}
}));

const stage = document.querySelector("[data-bridge-stage]");
const heroScroll = document.querySelector("[data-hero-scroll]");
const hero = heroScroll?.querySelector(".hero");
const storyPaths = stage ? {
  requestChannel: [...stage.querySelectorAll(".request-channel")],
  requestCli: [...stage.querySelectorAll(".request-cli")],
  returnCli: [...stage.querySelectorAll(".return-cli")],
  returnChannel: [...stage.querySelectorAll(".return-channel")],
} : null;

function updateStagePaths() {
  if (!stage) return;
  const svg = stage.querySelector(".stage-lines");
  const bridge = stage.querySelector(".bridge-core");
  const channelNodes = [...stage.querySelectorAll(".channel-node")];
  const cliNodes = [...stage.querySelectorAll(".cli-node")];
  if (!svg || !bridge || channelNodes.length !== 3 || cliNodes.length !== 4) return;
  const stageRect = stage.getBoundingClientRect();
  const localRect = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left - stageRect.left, right: rect.right - stageRect.left, top: rect.top - stageRect.top, bottom: rect.bottom - stageRect.top, cy: rect.top - stageRect.top + rect.height / 2 };
  };
  const bridgeRect = localRect(bridge);
  const curve = (from, to) => {
    const control = Math.max(10, Math.abs(to.x - from.x) * .42);
    return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} C${(from.x + control).toFixed(1)} ${from.y.toFixed(1)} ${(to.x - control).toFixed(1)} ${to.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
  };
  const bridgeHeight = bridgeRect.bottom - bridgeRect.top;
  const channelPorts = [.26, .5, .74];
  const cliPorts = [.18, .39, .61, .82];
  const channelCurves = channelNodes.map((node, index) => {
    const rect = localRect(node);
    const portY = bridgeRect.top + bridgeHeight * channelPorts[index];
    return curve({ x: rect.right, y: rect.cy }, { x: bridgeRect.left, y: portY });
  });
  const cliCurves = cliNodes.map((node, index) => {
    const rect = localRect(node);
    const portY = bridgeRect.top + bridgeHeight * cliPorts[index];
    return curve({ x: bridgeRect.right, y: portY }, { x: rect.left, y: rect.cy });
  });
  svg.setAttribute("viewBox", `0 0 ${stageRect.width.toFixed(1)} ${stageRect.height.toFixed(1)}`);
  [...stage.querySelectorAll(".flow-line.channel-path")].forEach((path, index) => path.setAttribute("d", channelCurves[index]));
  [...stage.querySelectorAll(".flow-line.cli-path")].forEach((path, index) => path.setAttribute("d", cliCurves[index]));
  storyPaths.requestChannel.forEach((path, index) => path.setAttribute("d", channelCurves[index % channelCurves.length]));
  storyPaths.returnChannel.forEach((path, index) => path.setAttribute("d", channelCurves[index % channelCurves.length]));
  storyPaths.requestCli.forEach((path, index) => path.setAttribute("d", cliCurves[index]));
  storyPaths.returnCli.forEach((path, index) => path.setAttribute("d", cliCurves[index]));
}

function setPathProgress(paths, progress, reverse = false) {
  for (const path of paths) {
    const moving = progress > 0 && progress < 1;
    path.style.opacity = moving ? "1" : "0";
    path.style.strokeDashoffset = String(reverse ? -progress : 1 - progress);
  }
}

function updateStory(progress) {
  if (!stage || !storyPaths) return;
  if (reduceMotion) {
    stage.dataset.storyPhase = "0";
    stage.classList.remove("story-execute");
    return;
  }
  const requestChannel = range(progress, .04, .27);
  const requestCli = range(progress, .24, .52);
  const execution = range(progress, .50, .72);
  const returnCli = range(progress, .68, .86);
  const returnChannel = range(progress, .82, .995);
  setPathProgress(storyPaths.requestChannel, requestChannel);
  setPathProgress(storyPaths.requestCli, requestCli);
  setPathProgress(storyPaths.returnCli, returnCli, true);
  setPathProgress(storyPaths.returnChannel, returnChannel, true);
  stage.classList.toggle("story-execute", execution > 0 && returnCli < 1);
  stage.dataset.storyPhase = progress < .04 || progress >= .995 ? "0" : progress < .27 ? "1" : progress < .52 ? "2" : progress < .72 ? "3" : "4";
}

if (stage) {
  stage.dataset.storyPhase = "0";
  const selectStageGroup = (group) => { if (group) stage.dataset.active = group; };
  stage.querySelectorAll("[data-stage-node]").forEach((node) => {
    node.addEventListener("pointerenter", () => selectStageGroup(node.dataset.stageNode));
    node.addEventListener("focus", () => selectStageGroup(node.dataset.stageNode));
    node.addEventListener("click", () => selectStageGroup(node.dataset.stageNode));
  });
  if (finePointer && !reduceMotion) {
    let pointerFrame = 0;
    stage.addEventListener("pointermove", (event) => {
      if (pointerFrame) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        const rect = stage.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        stage.style.setProperty("--mx", String((x - .5) * 2));
        stage.style.setProperty("--my", String((y - .5) * 2));
        if (event.target === stage || !event.target.closest("[data-stage-node]")) {
          selectStageGroup(x < .34 ? "channel" : x > .66 ? "cli" : "bridge");
        }
      });
    });
    stage.addEventListener("pointerleave", () => {
      stage.style.setProperty("--mx", "0");
      stage.style.setProperty("--my", "0");
      selectStageGroup("bridge");
    });
  }
  updateStagePaths();
  document.fonts?.ready.then(updateStagePaths);
}

const revealSelector = [
  ".section-heading", ".capability-card", ".system-map", ".architecture > .text-link",
  ".trust-intro", ".trust-list article", ".terminal-setup", ".quickstart > .text-link",
  ".proof-card", ".closing > *",
].join(",");
const revealUnits = [...document.querySelectorAll(revealSelector)];
revealUnits.forEach((element, index) => {
  element.dataset.scrollReveal = "";
  element.dataset.revealOrder = String(index);
});

function updateScrollMotion() {
  const viewportHeight = innerHeight;
  if (heroScroll && hero && stage) {
    const heroTop = heroScroll.getBoundingClientRect().top + scrollY;
    const stageTop = stage.getBoundingClientRect().top + scrollY;
    const storyStart = innerWidth > 1050 ? heroTop : stageTop - viewportHeight * .75;
    const progress = clamp01((scrollY - storyStart) / (viewportHeight * .2));
    updateStory(progress);
    stage.style.setProperty("--story", progress.toFixed(4));
  }
  if (!reduceMotion) {
    const measurements = revealUnits.map((element) => {
      const rect = element.getBoundingClientRect();
      const localDelay = Number(element.dataset.revealOrder) % 4 * .035;
      return clamp01((viewportHeight * (1 - localDelay) - rect.top) / (viewportHeight * .28));
    });
    revealUnits.forEach((element, index) => element.style.setProperty("--reveal", measurements[index].toFixed(4)));
    root.classList.add("scroll-motion");
  }
}

let scrollFrame = 0;
function requestScrollMotion() {
  syncHeader();
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateScrollMotion();
  });
}
addEventListener("scroll", requestScrollMotion, { passive: true });
addEventListener("resize", () => {
  updateStagePaths();
  requestScrollMotion();
});
requestScrollMotion();

const builder = document.querySelector("[data-command-builder]");
if (builder) {
  const words = ["codex", "claude", "opencode", "pi", "daemon"];
  const word = builder.querySelector("[data-command-word]");
  const prefix = builder.querySelector("[data-command-prefix]");
  const setup = builder.querySelector("[data-setup-command]");
  let adapterIndex = 0;
  let rotation;
  let flipTimer;

  function updateBuilder(channel, adapter, animate = false) {
    builder.dataset.channel = channel;
    builder.dataset.adapter = adapter;
    adapterIndex = words.indexOf(adapter);
    builder.querySelectorAll("[data-channel-choice]").forEach((button) => button.classList.toggle("active", button.dataset.channelChoice === channel));
    builder.querySelectorAll("[data-adapter-choice]").forEach((button) => button.classList.toggle("active", button.dataset.adapterChoice === adapter));
    prefix.textContent = `${channel}-`;
    setup.textContent = `${channel}-setup`;
    clearTimeout(flipTimer);
    if (animate && !reduceMotion) {
      word.classList.remove("flip-in");
      word.classList.add("flip-out");
      flipTimer = setTimeout(() => {
        word.textContent = adapter;
        word.classList.remove("flip-out");
        word.classList.add("flip-in");
        setTimeout(() => word.classList.remove("flip-in"), 380);
      }, 200);
    } else word.textContent = adapter;
  }
  function restartRotation() {
    clearInterval(rotation);
    if (reduceMotion) return;
    rotation = setInterval(() => {
      adapterIndex = (adapterIndex + 1) % words.length;
      updateBuilder(builder.dataset.channel, words[adapterIndex], true);
    }, 1200);
  }
  builder.querySelectorAll("[data-channel-choice]").forEach((button) => button.addEventListener("click", () => {
    updateBuilder(button.dataset.channelChoice, builder.dataset.adapter, false);
    restartRotation();
  }));
  builder.querySelectorAll("[data-adapter-choice]").forEach((button) => button.addEventListener("click", () => {
    updateBuilder(builder.dataset.channel, button.dataset.adapterChoice, true);
    restartRotation();
  }));
  builder.querySelectorAll("[data-copy-dynamic]").forEach((button) => button.addEventListener("click", async () => {
    const command = button.dataset.copyDynamic === "setup" ? `${builder.dataset.channel}-setup` : `${builder.dataset.channel}-${builder.dataset.adapter}`;
    try { await copyText(command); showCopied(button); } catch {}
  }));
  restartRotation();
}

const metricEls = [...document.querySelectorAll("[data-metric]")];
fetch(`${base}assets/generated/metrics.json`).then((response) => response.json()).then((data) => {
  metricEls.forEach((element) => {
    const value = data[element.dataset.metric];
    if (value === null || value === undefined) return;
    element.textContent = typeof value === "number" ? value.toLocaleString() : value;
  });
}).catch(() => {});
