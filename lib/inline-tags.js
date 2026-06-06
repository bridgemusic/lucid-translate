// 内联富文本标签保护 + HTML entity 解码。
// 目标：让 LLM 翻译块级内容时，绝不破坏 <a> <code> <b> 等内联结构。
//
// 策略（借鉴 kiss-translator 的标签四分类）：
//   REPLACE 类（代码/图片/上下标等内容不可翻）：整体替换为占位符 #1#，翻译后原样还原。
//   WARP 类（链接/强调等需保留标签、只翻内部文本）：序列化成 <b0>...</b0> 形式，
//            让模型保留 <b0> 这种轻量标记，回填时再换回真实标签与属性。
//
// 该文件以普通 content script 注入，挂到全局命名空间 window.LT。

(function () {
  const LT = (window.LT = window.LT || {});

  // 内容完全不可翻译、需整体保护的元素。
  const REPLACE_TAGS = new Set([
    "CODE", "KBD", "SAMP", "VAR", "PRE", "IMG", "SVG", "MATH",
    "SUB", "SUP", "BR", "WBR", "TIME", "DATA",
  ]);
  // 需要保留标签本体、只翻译内部文本的内联元素。
  const WARP_TAGS = new Set([
    "A", "B", "I", "EM", "STRONG", "SPAN", "MARK", "U", "S",
    "SMALL", "ABBR", "CITE", "Q", "DFN", "LABEL", "BDI", "BDO", "FONT",
  ]);

  // —— HTML entity 解码：LLM 常吐回 &#39; &amp; 等，需还原成真实字符 ——
  const _decoderEl = document.createElement("textarea");
  function decodeEntities(text) {
    if (!text || text.indexOf("&") === -1) return text;
    _decoderEl.innerHTML = text;
    return _decoderEl.value;
  }

  // 将一个块元素序列化为「带轻量标记的可翻译字符串」。
  // 返回 { text, placeholders }；placeholders 用于回填时还原 REPLACE/WARP。
  function serializeBlock(blockEl) {
    const placeholders = [];
    let replaceCounter = 0;
    let warpCounter = 0;

    function walk(node) {
      let out = "";
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName;
          if (REPLACE_TAGS.has(tag) || isUntranslatableEl(child)) {
            // 整体替换为占位符，记录原始节点用于还原。
            const id = replaceCounter++;
            placeholders.push({ kind: "replace", token: `#${id}#`, node: child.cloneNode(true) });
            out += `#${id}#`;
          } else if (WARP_TAGS.has(tag)) {
            const id = warpCounter++;
            const inner = walk(child);
            placeholders.push({ kind: "warp", id, tag: child.cloneNode(false) });
            out += `<w${id}>${inner}</w${id}>`;
          } else {
            // 其它（罕见的内联未知标签）：保守地按 warp 处理。
            const id = warpCounter++;
            const inner = walk(child);
            placeholders.push({ kind: "warp", id, tag: child.cloneNode(false) });
            out += `<w${id}>${inner}</w${id}>`;
          }
        }
      }
      return out;
    }

    const text = walk(blockEl);
    return { text, placeholders };
  }

  // 把模型返回的译文（含 <w0>…</w0> 和 #0# 标记）还原成真实 DOM，写回块元素。
  // opts.stripReplaced=true 时，REPLACE 类占位符（图片/SVG/视频等非文本内容）
  // 不还原其真实节点，而是丢弃 —— 用于双语模式的译文副本：原文里已有这些图片，
  // 副本只需文字，否则会把图片克隆一份导致页面出现重复图。
  function applyTranslation(blockEl, translated, placeholders, opts = {}) {
    const decoded = decodeEntities(translated);
    const warpById = new Map();
    const replaceByToken = new Map();
    for (const p of placeholders) {
      if (p.kind === "warp") warpById.set(p.id, p.tag);
      else if (!opts.stripReplaced) replaceByToken.set(p.token, p.node);
      // stripReplaced 时不登记 replace 节点；parseMarkedString 找不到则丢弃该占位符。
    }

    // 用 DOMParser 把标记字符串解析成节点树，再把 <wN> 换成真实标签、#N# 换成真实节点。
    const frag = parseMarkedString(decoded, warpById, replaceByToken);
    blockEl.replaceChildren(frag);
  }

  function parseMarkedString(str, warpById, replaceByToken) {
    // 标记串可能含嵌套 <wN>，用基于栈的递归解析（见 appendMarked），
    // 不用一次性正则替换（无法正确处理嵌套）。
    const frag = document.createDocumentFragment();
    appendMarked(frag, str, warpById, replaceByToken);
    return frag;
  }

  // 递归解析：扫描字符串，遇到 <wN> 开标签则递归其内部，遇到 #N# 则插入保护节点。
  function appendMarked(parent, str, warpById, replaceByToken) {
    let i = 0;
    while (i < str.length) {
      // 尝试匹配 warp 开标签 <wN>
      const openMatch = /^<w(\d+)>/.exec(str.slice(i));
      if (openMatch) {
        const id = Number(openMatch[1]);
        const closeTag = `</w${id}>`;
        const start = i + openMatch[0].length;
        const close = findMatchingClose(str, start, id);
        const innerStr = str.slice(start, close);
        const tagTemplate = warpById.get(id);
        const el = tagTemplate ? tagTemplate.cloneNode(false) : document.createElement("span");
        appendMarked(el, innerStr, warpById, replaceByToken);
        parent.appendChild(el);
        i = close + closeTag.length;
        continue;
      }
      // 尝试匹配 replace 占位符 #N#
      const repMatch = /^#(\d+)#/.exec(str.slice(i));
      if (repMatch) {
        const node = replaceByToken.get(repMatch[0]);
        if (node) parent.appendChild(node.cloneNode(true));
        i += repMatch[0].length;
        continue;
      }
      // 普通文本：吃到下一个标记前。
      const next = nextMarkerIndex(str, i);
      parent.appendChild(document.createTextNode(str.slice(i, next)));
      i = next;
    }
  }

  function nextMarkerIndex(str, from) {
    let best = str.length;
    const w = str.indexOf("<w", from);
    const r = str.indexOf("#", from);
    if (w !== -1 && w < best) best = w;
    if (r !== -1 && r < best) best = r;
    return best === from ? from + 1 : best; // 防止卡死
  }

  // 找到与 <wId> 配对的 </wId>，正确处理同 id 嵌套（罕见，但稳妥处理）。
  function findMatchingClose(str, from, id) {
    const open = `<w${id}>`;
    const close = `</w${id}>`;
    let depth = 1;
    let i = from;
    while (i < str.length) {
      const o = str.indexOf(open, i);
      const c = str.indexOf(close, i);
      if (c === -1) return str.length;
      if (o !== -1 && o < c) {
        depth++;
        i = o + open.length;
      } else {
        depth--;
        if (depth === 0) return c;
        i = c + close.length;
      }
    }
    return str.length;
  }

  // 某些元素即便是 warp 类标签，也应整体保护（如带 role 的图标、隐藏元素）。
  function isUntranslatableEl(el) {
    if (el.getAttribute && el.getAttribute("translate") === "no") return true;
    if (el.classList && el.classList.contains("notranslate")) return true;
    return false;
  }

  LT.inlineTags = {
    serializeBlock,
    applyTranslation,
    decodeEntities,
    REPLACE_TAGS,
    WARP_TAGS,
  };
})();
