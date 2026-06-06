// 自动弹窗决策回归测试：decideOffer 在各种条件下是否正确决定"弹/不弹"。
import { test } from "node:test";
import assert from "node:assert/strict";

// background.js 在模块顶层注册监听器并调用 createMenu()，需先把它用到的 chrome API 桩好。
const noop = () => {};
globalThis.chrome = {
  runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop } },
  contextMenus: { removeAll: (cb) => cb && cb(), create: noop, update: noop, onClicked: { addListener: noop } },
  tabs: { onActivated: { addListener: noop }, onUpdated: { addListener: noop }, sendMessage: noop },
  i18n: { detectLanguage: async () => ({ languages: [] }) },
  scripting: {},
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const { decideOffer } = await import("../background.js");

const base = {
  detectedLang: "en",
  percentage: 90,
  hasApiKey: true,
  hostname: "example.com",
  settings: {
    autoDetect: true,
    sourceLang: "en",
    targetLang: "zh-Hans",
    displayMode: "bilingual",
    blocklist: [],
  },
};

test("匹配源语言 + 有 key + 不在黑名单 → 弹窗，并带回翻译设置", () => {
  const r = decideOffer(base);
  assert.equal(r.offer, true);
  assert.equal(r.sourceLang, "en");
  assert.equal(r.targetLang, "zh-Hans");
  assert.equal(r.displayMode, "bilingual");
});

test("autoDetect 关闭 → 不弹", () => {
  assert.equal(decideOffer({ ...base, settings: { ...base.settings, autoDetect: false } }).offer, false);
});

test("无 API key → 不弹（不诱导失败）", () => {
  assert.equal(decideOffer({ ...base, hasApiKey: false }).offer, false);
});

test("域名在黑名单 → 不弹（忽略 www）", () => {
  const settings = { ...base.settings, blocklist: ["example.com"] };
  assert.equal(decideOffer({ ...base, hostname: "www.example.com", settings }).offer, false);
});

test("检测语言与源语言不符 → 不弹", () => {
  assert.equal(decideOffer({ ...base, detectedLang: "fr" }).offer, false);
});

test("占比过低（<50%）→ 不弹", () => {
  assert.equal(decideOffer({ ...base, percentage: 30 }).offer, false);
});

test("检测语言归一：en-US 视为 en", () => {
  assert.equal(decideOffer({ ...base, detectedLang: "en-US" }).offer, true);
});
