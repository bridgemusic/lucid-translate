// Popup 逻辑：语言选择、触发翻译/还原、自动检测、进度。
import { LANGUAGES, normalizeDetected, displayName } from "../lib/languages.js";
import { getSettings, saveSettings, getActiveProviderConfig } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);
const els = {
  source: $("sourceLang"),
  target: $("targetLang"),
  action: $("actionBtn"),
  settings: $("settingsBtn"),
  detect: $("detectHint"),
  progress: $("progress"),
  progressFill: $("progressFill"),
  progressText: $("progressText"),
  banner: $("banner"),
};

let settings = null;
let tabId = null;
let currentUrl = "";
let isActive = false;
let contentReady = false;

init();

async function init() {
  settings = await getSettings();
  populateLangs();
  els.source.value = settings.sourceLang;
  els.target.value = settings.targetLang;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  currentUrl = tab ? tab.url || "" : "";

  bindEvents();
  await checkApiKey();
  // 确保内容脚本已注入（应对「插件重载后页面已打开」「脚本未自动注入」等情况）。
  await ensureContentScript();
  await syncStatus();
  await autoDetect();
}

// 受限页面：浏览器禁止注入脚本，提前识别给出清晰提示。
function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("view-source:") ||
    url.startsWith("file://") // file:// 需用户单独授权，默认按受限处理
  );
}

// 若内容脚本尚未注入，则主动注入（按 manifest 顺序）。返回是否可用。
async function ensureContentScript() {
  if (!tabId) return false;
  // 先 ping，已注入则直接返回。
  const pong = await sendToTab({ type: "ping" });
  if (pong && pong.ok) {
    contentReady = true;
    return true;
  }
  if (isRestrictedUrl(currentUrl)) {
    contentReady = false;
    return false;
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/content.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "lib/inline-tags.js",
        "lib/dom-walker.js",
        "lib/batch-queue.js",
        "lib/observers.js",
        "content/content.js",
      ],
    });
    // 注入后再 ping 一次确认。
    const recheck = await sendToTab({ type: "ping" });
    contentReady = !!(recheck && recheck.ok);
    return contentReady;
  } catch (_) {
    contentReady = false;
    return false;
  }
}

function populateLangs() {
  for (const lang of LANGUAGES) {
    if (lang.code === "auto") continue; // 源/目标都需明确语言
    const o1 = new Option(lang.zh, lang.code);
    const o2 = new Option(lang.zh, lang.code);
    els.source.add(o1);
    els.target.add(o2);
  }
}

function bindEvents() {
  els.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.source.addEventListener("change", persistLangs);
  els.target.addEventListener("change", persistLangs);
  els.action.addEventListener("click", onAction);

  // 监听 content 的进度上报。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "progress") updateProgress(msg);
  });
}

async function persistLangs() {
  settings.sourceLang = els.source.value;
  settings.targetLang = els.target.value;
  await saveSettings({ sourceLang: settings.sourceLang, targetLang: settings.targetLang });
}

async function checkApiKey() {
  const cfg = await getActiveProviderConfig();
  if (!cfg.apiKey) {
    showBanner("warn", "尚未配置 API Key，点击右上角设置");
    els.action.disabled = true;
    return false;
  }
  els.action.disabled = false;
  return true;
}

async function onAction() {
  if (!tabId) return;
  if (isActive) {
    await sendToTab({ type: "restore" });
    setActive(false);
    hideProgress();
    return;
  }
  if (!(await checkApiKey())) return;

  // 点击时再确保一次脚本就绪（页面可能在 popup 打开后才加载完）。
  if (!contentReady) {
    if (isRestrictedUrl(currentUrl)) {
      showBanner("error", "此页面是浏览器受限页面，无法翻译（换一个普通网页试试）");
      return;
    }
    const ready = await ensureContentScript();
    if (!ready) {
      showBanner("error", "无法在此页面注入翻译脚本，请刷新页面后重试");
      return;
    }
  }

  const ok = await sendToTab({
    type: "translate",
    settings: {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      displayMode: settings.displayMode,
    },
  });
  if (ok) {
    setActive(true);
    showProgress();
  } else {
    showBanner("error", "无法在此页面运行，请刷新页面后重试");
  }
}

function setActive(active) {
  isActive = active;
  els.action.textContent = active ? "还原原文" : "翻译此页";
  els.action.classList.toggle("restore", active);
}

function showProgress() {
  els.progress.classList.remove("hidden");
}
function hideProgress() {
  els.progress.classList.add("hidden");
}

function updateProgress({ total, done, failed }) {
  if (!isActive) return;
  showProgress();
  const finished = done + failed;
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0;
  els.progressFill.style.width = pct + "%";
  let text = total > 0 ? `已翻译 ${done} / ${total} 段` : "正在扫描页面…";
  if (failed > 0) text += `（${failed} 段失败，可点击重试）`;
  els.progressText.textContent = text;
}

// 查询当前页状态，恢复 UI（popup 重新打开时）。
async function syncStatus() {
  const resp = await sendToTab({ type: "getStatus" });
  if (resp && resp.active) {
    setActive(true);
    updateProgress(resp);
  }
}

// 自动检测页面主语言，匹配源语言则高亮提示。
async function autoDetect() {
  const resp = await sendToTab({ type: "getSample" });
  if (!resp || !resp.sample) return;
  const det = await chrome.runtime.sendMessage({ type: "detectLanguage", sample: resp.sample });
  if (!det || !det.ok || !det.language) return;
  const norm = normalizeDetected(det.language);
  if (norm && norm === settings.sourceLang && det.percentage >= 50) {
    els.detect.textContent = `检测到${displayName(settings.sourceLang)}页面，可一键翻译`;
    els.detect.classList.remove("hidden");
  } else if (norm && norm !== settings.sourceLang) {
    // 页面主语言与设定源语言不同：温和提示，不强制。
    const guess = LANGUAGES.find((l) => l.code === norm);
    if (guess) {
      els.detect.textContent = `检测到${guess.zh}页面`;
      els.detect.classList.remove("hidden");
    }
  }
}

function showBanner(kind, text) {
  els.banner.textContent = text;
  els.banner.className = "banner " + kind;
}

// 向当前标签页发消息；content 未注入时返回 null。
function sendToTab(msg) {
  return new Promise((resolve) => {
    if (!tabId) return resolve(null);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}
