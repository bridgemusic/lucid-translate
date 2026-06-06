// Content script：页面内编排。
// 职责：响应 popup 命令 → 收集块 → 懒翻译 → 序列化保护 → 批处理 → 流式逐段渲染 → 还原。
// 依赖（按 manifest 顺序先于本文件注入）：window.LT.{inlineTags, domWalker, batchQueue, observers}

(function () {
  const LT = window.LT;
  if (!LT) return; // 依赖未就绪（极端情况），安全退出
  if (window.__ltContentReady) return; // 防重复注入
  window.__ltContentReady = true;

  const STATE = {
    active: false,
    mode: "bilingual", // 来自设置
    sourceLang: "en",
    targetLang: "zh-Hans",
    total: 0,
    done: 0,
    failed: 0,
  };

  let queue = null;
  let observers = null;
  // 每个块的状态记录：el -> { placeholders, originalHTML }
  const blockRecords = new WeakMap();

  // —— 与 background 通信：发送一批待译段落 ——
  function sendBatch(segments) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "translateBatch",
          segments,
          sourceLang: STATE.sourceLang,
          targetLang: STATE.targetLang,
        },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp) return reject(new Error("no response"));
          if (!resp.ok) return reject(new Error(resp.error || "translate failed"));
          resolve(resp.results);
        }
      );
    });
  }

  // —— 单个块：序列化 → 入队 → 渲染 ——
  let segIdCounter = 0;
  function translateBlock(el) {
    if (!el.isConnected) return;
    if (el.dataset.ltState) return; // 已处理/处理中
    el.dataset.ltState = "pending";

    const { text, placeholders } = LT.inlineTags.serializeBlock(el);
    if (!text || !text.trim()) {
      el.dataset.ltState = "skip";
      return;
    }
    blockRecords.set(el, { placeholders, originalHTML: el.innerHTML });

    setLoading(el, true);
    STATE.total++;
    notifyProgress();

    const id = segIdCounter++;
    queue
      .enqueue({ id, text })
      .then((translated) => {
        if (!el.isConnected) return;
        renderTranslation(el, translated, placeholders);
        el.dataset.ltState = "done";
        STATE.done++;
      })
      .catch(() => {
        if (!el.isConnected) return;
        setError(el, true);
        el.dataset.ltState = "error";
        STATE.failed++;
      })
      .finally(() => {
        setLoading(el, false);
        notifyProgress();
      });
  }

  // —— 渲染：双语 vs 原地替换 ——
  function renderTranslation(el, translated, placeholders) {
    if (STATE.mode === "replace") {
      // 原地：直接重建块内容。
      LT.inlineTags.applyTranslation(el, translated, placeholders);
    } else {
      // 双语：在原块后插入一个译文块，原文保留。
      let trans = el.nextElementSibling;
      if (!(trans && trans.dataset && trans.dataset.ltInjected !== undefined)) {
        trans = document.createElement(el.tagName === "LI" || el.tagName === "TD" ? "div" : el.tagName);
        trans.dataset.ltInjected = "";
        trans.className = "lt-translation";
        observers && observers.markInjected(trans);
        el.insertAdjacentElement("afterend", trans);
      }
      // 双语副本只放文字：stripReplaced 丢弃图片/SVG/视频等占位符，
      // 否则会把原文已有的图片再克隆一份，导致页面出现重复图。
      LT.inlineTags.applyTranslation(trans, translated, placeholders, { stripReplaced: true });
    }
  }

  function setLoading(el, on) {
    if (on) {
      // 按该块的实际背景亮度设定扫光颜色：浅色背景用淡暗光、深色背景用淡白光，
      // 始终是"比背景略不同的柔光"，既不会白叠白看不见，也不会在深色页刺眼。
      const dark = isDarkBackground(el);
      el.style.setProperty("--lt-glow", dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.055)");
    }
    el.classList.toggle("lt-loading", !!on);
  }

  // 向上寻找第一个不透明背景色，估算其亮度，判断是否为深色背景。
  function isDarkBackground(el) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const bg = getComputedStyle(node).backgroundColor;
      const rgba = parseRgb(bg);
      if (rgba && rgba.a > 0.1) {
        // 相对亮度（sRGB 近似），<0.5 视为深色。
        const lum = (0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b) / 255;
        return lum < 0.5;
      }
      node = node.parentElement;
    }
    // 一路透明到根：以页面 body/html 背景或默认白底判断 → 视为浅色。
    return false;
  }

  function parseRgb(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    const [r, g, b, a = 1] = parts;
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }
  function setError(el, on) {
    el.classList.toggle("lt-error", !!on);
    if (on) {
      el.title = "翻译失败，点击重试";
      el.addEventListener("click", retryHandler, { once: true });
    }
  }
  function retryHandler(e) {
    const el = e.currentTarget;
    el.classList.remove("lt-error");
    el.removeAttribute("title");
    delete el.dataset.ltState;
    STATE.failed = Math.max(0, STATE.failed - 1);
    STATE.total = Math.max(0, STATE.total - 1);
    translateBlock(el);
  }

  // —— 收集并调度（懒翻译）——
  function scanAndObserve(root) {
    const blocks = LT.domWalker.collectBlocks(root || document.body, []);
    if (blocks.length) observers.observeBlocks(blocks);
  }

  // —— 启动翻译 ——
  function startTranslation(settings) {
    if (STATE.active) return;
    STATE.active = true;
    STATE.mode = settings.displayMode || "bilingual";
    STATE.sourceLang = settings.sourceLang || "en";
    STATE.targetLang = settings.targetLang || "zh-Hans";
    STATE.total = STATE.done = STATE.failed = 0;

    queue = LT.batchQueue.createQueue(sendBatch);
    observers = LT.observers.createObservers({ onBlockVisible: translateBlock });
    observers.start();

    scanAndObserve(document.body);
    // SPA：监听新增内容与路由变化。
    observers.startMutationObserver((newRoot) => {
      if (!STATE.active) return;
      scanAndObserve(newRoot);
    });
    observers.hookHistory(() => {
      if (!STATE.active) return;
      scanAndObserve(document.body);
    });
    notifyProgress();
  }

  // —— 还原原文 ——
  function restore() {
    STATE.active = false;
    if (observers) observers.stop();
    // 移除注入的译文块。
    document.querySelectorAll("[data-lt-injected]").forEach((n) => n.remove());
    // 原地替换模式：恢复原始 HTML。
    document.querySelectorAll('[data-lt-state="done"]').forEach((el) => {
      const rec = blockRecords.get(el);
      if (STATE.mode === "replace" && rec) el.innerHTML = rec.originalHTML;
    });
    // 清理所有标记与样式类。
    document
      .querySelectorAll('[data-lt-state], .lt-loading, .lt-error')
      .forEach((el) => {
        delete el.dataset.ltState;
        el.classList.remove("lt-loading", "lt-error");
        el.removeAttribute("title");
      });
    STATE.total = STATE.done = STATE.failed = 0;
    queue = null;
    observers = null;
    notifyProgress();
  }

  // —— 进度上报（popup 打开时监听）——
  function notifyProgress() {
    chrome.runtime
      .sendMessage({
        type: "progress",
        active: STATE.active,
        total: STATE.total,
        done: STATE.done,
        failed: STATE.failed,
      })
      .catch(() => {}); // popup 未打开时忽略
  }

  // —— 供 popup 检测语言用：取样页面可见文本 ——
  function sampleText() {
    const text = (document.body && document.body.innerText) || "";
    return text.replace(/\s+/g, " ").trim().slice(0, 1000);
  }

  // —— popup 命令入口 ——
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "ping":
        sendResponse({ ok: true });
        return;
      case "getStatus":
        sendResponse({
          ok: true,
          active: STATE.active,
          total: STATE.total,
          done: STATE.done,
          failed: STATE.failed,
        });
        return;
      case "getSample":
        sendResponse({ ok: true, sample: sampleText() });
        return;
      case "translate":
        startTranslation(msg.settings || {});
        sendResponse({ ok: true });
        return;
      case "restore":
        restore();
        sendResponse({ ok: true });
        return;
      default:
        return;
    }
  });
})();
