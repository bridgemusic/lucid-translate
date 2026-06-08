// 自动弹窗决策回归测试：decideOffer 在各种条件下是否正确决定"弹/不弹"。
import { test } from "node:test";
import assert from "node:assert/strict";

// background.js 在模块顶层注册监听器并调用 createMenu()，需先把它用到的 chrome API 桩好。
const noop = () => {};
const sessionStore = {};
globalThis.chrome = {
  runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop } },
  contextMenus: { removeAll: (cb) => cb && cb(), create: noop, update: noop, onClicked: { addListener: noop } },
  tabs: { onActivated: { addListener: noop }, onUpdated: { addListener: noop }, sendMessage: noop },
  i18n: { detectLanguage: async () => ({ languages: [] }) },
  scripting: {},
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: {
      get: async (key) => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
      set: async (patch) => Object.assign(sessionStore, patch),
    },
  },
};

const { decideOffer, setSiteActive, isSiteActive } = await import("../background.js");

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

// —— 本会话续翻名单（同域整页跳转后自动续翻）——
test("setSiteActive/isSiteActive：标记后命中，忽略 www", async () => {
  assert.equal(await isSiteActive("scmp.com"), false);
  await setSiteActive("www.scmp.com", true);
  assert.equal(await isSiteActive("scmp.com"), true, "整页跳转后同域应续翻");
  assert.equal(await isSiteActive("www.scmp.com"), true);
});

test("setSiteActive(false)：还原后清除，停止续翻", async () => {
  await setSiteActive("foo.com", true);
  assert.equal(await isSiteActive("foo.com"), true);
  await setSiteActive("foo.com", false);
  assert.equal(await isSiteActive("foo.com"), false, "点还原后该站不再续翻");
});

test("续翻仅限同域：未标记的别站不续翻", async () => {
  await setSiteActive("a.com", true);
  assert.equal(await isSiteActive("b.com"), false, "跳到别的网站不应自动翻译");
});
