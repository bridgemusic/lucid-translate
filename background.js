// Service worker：唯一对外发请求的地方。
// API key 只在这里读取，绝不下发到页面世界（content script）。

import { translate, testConnection } from "./lib/providers.js";
import {
  getActiveProviderConfig,
  getSettings,
  addToBlocklist,
  hostInList,
  normalizeHostname,
} from "./lib/storage.js";
import { normalizeDetected, displayName } from "./lib/languages.js";

const MENU_ID = "lt-toggle";

// 消息路由。返回 true 以保持 sendResponse 异步可用。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "translateBatch":
      handleTranslateBatch(msg, sendResponse);
      return true;

    case "testConnection":
      handleTestConnection(msg, sendResponse);
      return true;

    case "detectLanguage":
      handleDetectLanguage(msg, sendResponse);
      return true;

    case "autoOffer":
      handleAutoOffer(msg, sendResponse);
      return true;

    case "dismissOffer":
      addToBlocklist(msg.hostname).finally(() => sendResponse({ ok: true }));
      return true;

    case "menuState":
      updateMenuTitle(msg.active);
      sendResponse({ ok: true });
      return;

    case "siteActive":
      // content 翻译开始/还原时上报，维护"本会话续翻域名"集合（活过整页跳转）。
      setSiteActive(msg.hostname, msg.active).finally(() => sendResponse({ ok: true }));
      return true;

    case "shouldAutoTranslate":
      // 新页面加载时查询：该域名是否在本会话续翻名单里。是则一并带回翻译设置。
      handleShouldAutoTranslate(msg, sendResponse);
      return true;

    default:
      return;
  }
});

// —— 本会话续翻名单（chrome.storage.session：活过整页跳转，关浏览器即清空）——
const SITES_KEY = "activeSites";

export async function setSiteActive(hostname, active) {
  const h = normalizeHostname(hostname);
  if (!h) return;
  const { [SITES_KEY]: sites = {} } = await chrome.storage.session.get(SITES_KEY);
  if (active) sites[h] = true;
  else delete sites[h];
  await chrome.storage.session.set({ [SITES_KEY]: sites });
}

export async function isSiteActive(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  const { [SITES_KEY]: sites = {} } = await chrome.storage.session.get(SITES_KEY);
  return !!sites[h];
}

async function handleShouldAutoTranslate(msg, sendResponse) {
  try {
    const active = await isSiteActive(msg.hostname);
    if (!active) {
      sendResponse({ ok: true, active: false });
      return;
    }
    // 续翻时带回用户当前翻译设置，保证语言/呈现模式与手动翻译一致。
    const s = await getSettings();
    sendResponse({
      ok: true,
      active: true,
      settings: {
        sourceLang: s.sourceLang,
        targetLang: s.targetLang,
        displayMode: s.displayMode,
      },
    });
  } catch (_) {
    sendResponse({ ok: true, active: false });
  }
}

async function handleTranslateBatch(msg, sendResponse) {
  try {
    const config = await getActiveProviderConfig();
    if (!config.apiKey) {
      sendResponse({ ok: false, error: "NO_API_KEY" });
      return;
    }
    const results = await translate({
      segments: msg.segments,
      sourceLang: msg.sourceLang,
      targetLang: msg.targetLang,
      config,
    });
    sendResponse({ ok: true, results });
  } catch (err) {
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

async function handleTestConnection(msg, sendResponse) {
  try {
    // 允许从 options 直接传入待测配置（尚未保存的草稿）。
    const config = msg.config || (await getActiveProviderConfig());
    const sample = await testConnection(config);
    sendResponse({ ok: true, sample });
  } catch (err) {
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// 语言检测放在 background：chrome.i18n.detectLanguage 在 SW 可用，免费、不耗 API。
async function handleDetectLanguage(msg, sendResponse) {
  try {
    const sample = (msg.sample || "").slice(0, 1000);
    if (!sample.trim()) {
      sendResponse({ ok: true, language: null, percentage: 0 });
      return;
    }
    const result = await chrome.i18n.detectLanguage(sample);
    const top =
      result && result.languages && result.languages.length ? result.languages[0] : null;
    sendResponse({
      ok: true,
      language: top ? top.language : null,
      percentage: top ? top.percentage : 0,
      reliable: result ? result.isReliable : false,
    });
  } catch (err) {
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// —— 自动弹窗决策 ——
// 纯决策函数（无 chrome 依赖，便于测试）：给定检测结果与设置，返回是否该弹窗。
export function decideOffer({ detectedLang, percentage, settings, hasApiKey, hostname }) {
  if (!settings || !settings.autoDetect) return { offer: false };
  if (!hasApiKey) return { offer: false }; // 没 key 弹了也白弹
  if (hostInList(hostname, settings.blocklist)) return { offer: false };
  const norm = normalizeDetected(detectedLang);
  if (!norm || norm !== settings.sourceLang) return { offer: false };
  if ((percentage || 0) < 50) return { offer: false };
  return {
    offer: true,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    displayMode: settings.displayMode,
  };
}

async function handleAutoOffer(msg, sendResponse) {
  try {
    const settings = await getSettings();
    // 提前短路：自动检测关 / 在黑名单 → 不必调检测。
    if (!settings.autoDetect || hostInList(msg.hostname, settings.blocklist)) {
      sendResponse({ ok: true, offer: false });
      return;
    }
    const cfg = await getActiveProviderConfig();
    const sample = (msg.sample || "").slice(0, 1000);
    let detectedLang = null;
    let percentage = 0;
    if (sample.trim()) {
      const result = await chrome.i18n.detectLanguage(sample);
      const top =
        result && result.languages && result.languages.length ? result.languages[0] : null;
      if (top) {
        detectedLang = top.language;
        percentage = top.percentage;
      }
    }
    const decision = decideOffer({
      detectedLang,
      percentage,
      settings,
      hasApiKey: !!cfg.apiKey,
      hostname: msg.hostname,
    });
    sendResponse({
      ok: true,
      ...decision,
      langName: decision.offer ? displayName(settings.sourceLang) : "",
    });
  } catch (err) {
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// —— 右键菜单 ——
function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "翻译此页",
      contexts: ["page", "selection"],
    });
  });
}

function updateMenuTitle(active) {
  chrome.contextMenus.update(MENU_ID, { title: active ? "还原原文" : "翻译此页" }, () => {
    void chrome.runtime.lastError; // 菜单可能尚未创建，忽略
  });
}

// 点击菜单：始终发 toggle 给 content，由 content 按真实状态翻转。
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  const settings = await getSettings();
  const payload = {
    type: "toggle",
    settings: {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      displayMode: settings.displayMode,
    },
  };
  const sent = await sendToTab(tab.id, payload);
  if (!sent) {
    // content 未注入（页面在插件加载前已打开）→ 注入后重试。
    const injected = await ensureInjected(tab.id, tab.url);
    if (injected) await sendToTab(tab.id, payload);
  }
});

// —— 切 tab / 导航时同步菜单文案 ——
chrome.tabs.onActivated.addListener(({ tabId }) => syncMenuForTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab && tab.active) syncMenuForTab(tabId);
});

async function syncMenuForTab(tabId) {
  const resp = await sendToTab(tabId, { type: "getStatus" });
  updateMenuTitle(!!(resp && resp.active)); // 未注入 → resp 为 null → 置"翻译此页"
}

// —— 向 tab 发消息（content 未注入时返回 null）——
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp || null);
    });
  });
}

// —— 注入兜底：复刻 manifest 的 content_scripts 注入序列 ——
const RESTRICTED = /^(chrome|chrome-extension|edge|about|view-source):|^https:\/\/chrome(webstore)?\.google\.com|^https:\/\/chromewebstore\.google\.com/;
async function ensureInjected(tabId, url) {
  if (url && RESTRICTED.test(url)) return false;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/content.css"] });
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
    return true;
  } catch (_) {
    return false;
  }
}

// 首次安装打开设置页 + 建右键菜单。SW 重启时菜单也需重建。
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
  createMenu();
});
// SW 冷启动（非安装）时也确保菜单存在。
createMenu();
