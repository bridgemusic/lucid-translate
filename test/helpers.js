// 测试辅助：搭建 jsdom 环境，并按 Chrome content_scripts 的方式加载 IIFE 库到 window.LT。
//
// 产品里这些库（lib/inline-tags.js 等）以普通 content script 注入，共享 isolated world
// 的 window.LT 命名空间。这里用同样的方式（读文件 + 在 window 作用域 eval）还原该环境，
// 使测试覆盖的就是真实运行路径。

import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 创建一个新的 jsdom + LT 环境。每个测试文件调用一次，互不污染。
//   opts.html       初始 body HTML
//   opts.libs       要加载的 lib 文件（相对项目根），默认全部 content 侧 IIFE 库
export function createEnv(opts = {}) {
  const {
    html = "<!DOCTYPE html><body></body>",
    libs = ["lib/inline-tags.js", "lib/dom-walker.js", "lib/batch-queue.js", "lib/observers.js"],
  } = opts;

  const dom = new JSDOM(html, { pretendToBeVisual: true, url: "https://example.com/" });
  const { window } = dom;

  // jsdom 不实现 IntersectionObserver；提供一个可手动触发的桩。
  const ioInstances = [];
  window.IntersectionObserver = class {
    constructor(cb, options) {
      this.cb = cb;
      this.options = options;
      this.observed = new Set();
      ioInstances.push(this);
    }
    observe(el) {
      this.observed.add(el);
    }
    unobserve(el) {
      this.observed.delete(el);
    }
    disconnect() {
      this.observed.clear();
    }
    // 测试用：把已观察的元素当作"进入视口"触发回调。
    trigger(els) {
      const targets = els || [...this.observed];
      this.cb(targets.map((target) => ({ isIntersecting: true, target })));
    }
  };

  // 在 window 作用域内执行 IIFE 库（等价于 content script 注入）。
  const context = vm.createContext(window);
  for (const rel of libs) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    vm.runInContext(code, context, { filename: rel });
  }

  return { dom, window, document: window.document, LT: window.LT, ioInstances };
}

// 便捷断言：从 body 收集所有翻译块，返回其去空白后的文本数组。
export function collectTexts(LT, document) {
  return LT.domWalker
    .collectBlocks(document.body, [])
    .map((b) => b.textContent.trim().replace(/\s+/g, " "));
}
