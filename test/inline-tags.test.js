// 内联标签保护回归测试：序列化 → 翻译 → 还原，确保 <a>/<code>/<img> 等不被破坏。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnv } from "./helpers.js";

test("纯文本：原样序列化并替换", () => {
  const { LT, document } = createEnv();
  const p = document.createElement("p");
  p.textContent = "Hello world";
  const { text, placeholders } = LT.inlineTags.serializeBlock(p);
  assert.equal(text, "Hello world");
  assert.equal(placeholders.length, 0);
  LT.inlineTags.applyTranslation(p, "你好世界", placeholders);
  assert.equal(p.textContent, "你好世界");
});

test("WARP 类：链接标签与属性保留，仅内部文本被翻译", () => {
  const { LT, document } = createEnv();
  const p = document.createElement("p");
  p.innerHTML = `Visit <a href="https://x.com" class="lnk">our site</a> now`;
  const { text, placeholders } = LT.inlineTags.serializeBlock(p);
  assert.match(text, /Visit <w0>our site<\/w0> now/);
  LT.inlineTags.applyTranslation(p, "现在访问 <w0>我们的网站</w0>", placeholders);
  const a = p.querySelector("a");
  assert.ok(a, "链接元素应保留");
  assert.equal(a.getAttribute("href"), "https://x.com");
  assert.equal(a.getAttribute("class"), "lnk");
  assert.equal(a.textContent, "我们的网站");
  assert.ok(p.textContent.includes("现在访问"));
});

test("REPLACE 类：代码内容被占位符保护，翻译后原样还原", () => {
  const { LT, document } = createEnv();
  const p = document.createElement("p");
  p.innerHTML = `Run <code>npm install</code> first`;
  const { text, placeholders } = LT.inlineTags.serializeBlock(p);
  assert.ok(text.includes("#0#"), "代码应被替换为占位符");
  assert.ok(!text.includes("npm install"), "代码内容不应出现在待译文本里");
  LT.inlineTags.applyTranslation(p, "先运行 #0#", placeholders);
  const code = p.querySelector("code");
  assert.ok(code, "代码元素应还原");
  assert.equal(code.textContent, "npm install");
});

test("嵌套 WARP：strong/em 结构与文本均正确还原", () => {
  const { LT, document } = createEnv();
  const p = document.createElement("p");
  p.innerHTML = `This is <strong>very <em>important</em></strong> indeed`;
  const { placeholders } = LT.inlineTags.serializeBlock(p);
  LT.inlineTags.applyTranslation(p, "这<w0>非常<w1>重要</w1></w0>确实", placeholders);
  assert.ok(p.querySelector("strong"), "strong 应保留");
  assert.ok(p.querySelector("strong em"), "嵌套 em 应保留");
  assert.equal(p.querySelector("em").textContent, "重要");
});

test("HTML 实体：模型回传 &#39; &amp; 时应解码为真实字符", () => {
  const { LT, document } = createEnv();
  const p = document.createElement("p");
  p.textContent = "Tom's book & pen";
  const { placeholders } = LT.inlineTags.serializeBlock(p);
  LT.inlineTags.applyTranslation(p, "汤姆&#39;s 书 &amp; 笔", placeholders);
  assert.equal(p.textContent, "汤姆's 书 & 笔");
});

test("stripReplaced：双语副本丢弃图片占位符，仅保留文字", () => {
  const { LT, document } = createEnv();
  const p = document.createElement("p");
  p.innerHTML = `<img src="flag.jpg">Breaking news today`;
  const { text, placeholders } = LT.inlineTags.serializeBlock(p);
  const copy = document.createElement("div");
  LT.inlineTags.applyTranslation(copy, text, placeholders, { stripReplaced: true });
  assert.equal(copy.querySelectorAll("img").length, 0, "双语副本不应克隆图片");
  assert.ok(copy.textContent.includes("Breaking news"));
});

test("stripReplaced 关闭时（原地模式）图片正常保留", () => {
  const { LT, document } = createEnv();
  const p = document.createElement("p");
  p.innerHTML = `<img src="flag.jpg">Breaking news today`;
  const { text, placeholders } = LT.inlineTags.serializeBlock(p);
  const repl = document.createElement("p");
  LT.inlineTags.applyTranslation(repl, text, placeholders);
  assert.equal(repl.querySelectorAll("img").length, 1, "原地模式应保留图片");
});
