// Service worker：唯一对外发请求的地方。
// API key 只在这里读取，绝不下发到页面世界（content script）。

import { translate, testConnection } from "./lib/providers.js";
import { getActiveProviderConfig, getSettings } from "./lib/storage.js";

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

    default:
      return;
  }
});

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

// 首次安装打开设置页，引导用户填 key（无 key 则无法翻译）。
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
  // 占位：未来可在此做配置迁移。
  void getSettings;
});
