// 块切分回归测试：覆盖这几轮反复出现的漏翻 / 重复收集 bug。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnv, collectTexts } from "./helpers.js";

function collect(html) {
  const { LT, document } = createEnv({ html: `<!DOCTYPE html><body>${html}</body>` });
  return collectTexts(LT, document);
}

test("基础：普通段落各自成块", () => {
  const t = collect(`<article><p>Para one here.</p><p>Para two here.</p></article>`);
  assert.equal(t.length, 2);
});

test("漏翻修复①：标题文字包在 <a> 里也能收集", () => {
  const t = collect(`<div><h3><a href="#">Big Title Here</a></h3><p>Description.</p></div>`);
  assert.ok(t.some((x) => x.includes("Big Title")), "链接内标题应被收集");
  assert.ok(t.some((x) => x.includes("Description")));
});

test("漏翻修复②：游离内联栏目标签被收回", () => {
  const t = collect(
    `<div><a class="cat">SCIENCE</a><h3><a href="#">Headline</a></h3><p>Desc.</p></div>`
  );
  assert.ok(t.some((x) => x === "SCIENCE"), "栏目标签应被收集");
  assert.ok(t.some((x) => x.includes("Headline")));
  assert.ok(t.some((x) => x.includes("Desc")));
});

test("重复收集修复：<a><h2>标题</h2></a> 标题只收 1 次", () => {
  const t = collect(`<div><a href="#"><h2>Big Title</h2></a><p>Desc here.</p></div>`);
  assert.equal(
    t.filter((x) => x.includes("Big Title")).length,
    1,
    "外层<a>不应与内层<h2>重复收集同一标题"
  );
});

test("重复收集修复：链接包多层块，标题仍只收 1 次", () => {
  const t = collect(
    `<div><a href="#"><div class="wrap"><h3>Nested Title</h3><span>sub</span></div></a><p>body</p></div>`
  );
  assert.equal(t.filter((x) => x.includes("Nested Title")).length, 1);
});

test("段落内的内联链接不被单独重复收集", () => {
  const t = collect(`<p>Visit <a href="#">our site</a> for details now</p>`);
  assert.equal(t.length, 1);
  assert.ok(!t.some((x) => x === "our site"));
});

test("多个游离内联标签都能收集", () => {
  const t = collect(`<div><span>TAG1</span><span>TAG2</span><h2>Heading</h2></div>`);
  assert.ok(t.includes("TAG1") && t.includes("TAG2") && t.includes("Heading"));
});

test("跳过不可翻容器：script / style / code / notranslate", () => {
  const t = collect(`
    <div>
      <pre><code>const x = 1;</code></pre>
      <p>real text content</p>
      <span class="notranslate">skip me</span>
      <script>console.log("ignore")</script>
      <style>.x{color:red}</style>
    </div>`);
  assert.ok(!t.some((x) => x.includes("const x")), "代码块应跳过");
  assert.ok(!t.some((x) => x.includes("skip me")), "notranslate 应跳过");
  assert.ok(!t.some((x) => x.includes("ignore")), "script 应跳过");
  assert.ok(t.some((x) => x.includes("real text")), "正文应保留");
});

test("跳过纯噪音文本：纯数字 / URL", () => {
  const t = collect(
    `<div><span>12345</span><a href="#">https://x.com</a><h3>Real Title</h3><p>body text</p></div>`
  );
  assert.ok(!t.some((x) => x === "12345"), "纯数字应跳过");
  assert.ok(!t.some((x) => x.includes("x.com")), "URL 应跳过");
  assert.ok(t.some((x) => x.includes("Real Title")));
});

test("图文同块：含图段落只收 1 次（图片不致重复块）", () => {
  const t = collect(`<p class="cap"><img src="a.jpg">News text here</p>`);
  assert.equal(t.filter((x) => x.includes("News text")).length, 1);
});

test("纯图片链接（alt 不计入文本）不被当翻译单元", () => {
  const { LT, document } = createEnv({
    html: `<!DOCTYPE html><body><div><a href="#"><img alt="photo caption" src="a.jpg"></a><h3>Title</h3><p>body</p></div></body>`,
  });
  const blocks = LT.domWalker.collectBlocks(document.body, []);
  const imgBlocks = blocks.filter((b) => b.querySelectorAll("img").length > 0);
  assert.equal(imgBlocks.length, 0, "图片链接不应作为翻译单元");
});
