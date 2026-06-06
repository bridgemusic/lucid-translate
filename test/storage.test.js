// storage 回归测试：域名归一/匹配纯函数 + blocklist 读写（mock chrome.storage.local）。
import { test } from "node:test";
import assert from "node:assert/strict";

// 在 import storage.js 前装好 chrome.storage.local 的内存桩。
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        if (key === null) return { ...store };
        if (typeof key === "string") return key in store ? { [key]: store[key] } : {};
        return {};
      },
      set: async (patch) => Object.assign(store, patch),
    },
  },
};

const {
  normalizeHostname,
  hostInList,
  addToBlocklist,
  isBlocklisted,
  clearBlocklist,
  getSettings,
} = await import("../lib/storage.js");

test("normalizeHostname：小写、去 www、去空白", () => {
  assert.equal(normalizeHostname("WWW.Example.COM"), "example.com");
  assert.equal(normalizeHostname("  News.Ycombinator.com "), "news.ycombinator.com");
  assert.equal(normalizeHostname(""), "");
  assert.equal(normalizeHostname(null), "");
});

test("hostInList：忽略 www / 大小写差异", () => {
  const list = ["example.com", "WWW.Foo.org"];
  assert.equal(hostInList("www.example.com", list), true);
  assert.equal(hostInList("foo.org", list), true);
  assert.equal(hostInList("other.com", list), false);
  assert.equal(hostInList("", list), false);
});

test("addToBlocklist / isBlocklisted：写入后命中，且 www 视为同一域", async () => {
  delete store.blocklist;
  assert.equal(await isBlocklisted("scmp.com"), false);
  await addToBlocklist("www.scmp.com");
  assert.equal(await isBlocklisted("scmp.com"), true);
  assert.equal(await isBlocklisted("www.scmp.com"), true);
});

test("addToBlocklist：去重，不重复写入", async () => {
  store.blocklist = [];
  await addToBlocklist("a.com");
  await addToBlocklist("www.a.com"); // 归一后同一域
  assert.deepEqual(store.blocklist, ["a.com"]);
});

test("clearBlocklist：清空", async () => {
  store.blocklist = ["a.com", "b.com"];
  await clearBlocklist();
  assert.deepEqual(store.blocklist, []);
});

test("getSettings：autoDetect 默认开启", async () => {
  delete store.autoDetect;
  const s = await getSettings();
  assert.equal(s.autoDetect, true);
});
