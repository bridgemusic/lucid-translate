// DOM 块级切分 + 嵌套穿透（Shadow DOM / 同源 iframe）+ skip 规则。
// 这是产品「网站可适配性」的命脉。挂到 window.LT。

(function () {
  const LT = (window.LT = window.LT || {});

  // 不进入的容器（其内部文本一律不翻译）。
  const SKIP_CONTAINER = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "KBD", "SAMP",
    "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH", "CANVAS", "VIDEO",
    "AUDIO", "IFRAME", "OBJECT", "EMBED", "MAP", "HEAD", "TITLE",
  ]);

  // 块级标签白名单：作为翻译单元的边界。
  const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "ARTICLE", "SECTION",
    "BLOCKQUOTE", "TD", "TH", "CAPTION", "DD", "DT", "FIGCAPTION", "SUMMARY",
    "DETAILS", "ASIDE", "HEADER", "FOOTER", "MAIN", "NAV", "ADDRESS",
    "LEGEND",
  ]);

  // 内联标签：不单独成块，作为其父块的一部分被序列化。
  const INLINE_TAGS = new Set([
    "A", "B", "I", "EM", "STRONG", "SPAN", "MARK", "U", "S", "SMALL",
    "ABBR", "CITE", "Q", "DFN", "LABEL", "SUB", "SUP", "BDI", "BDO", "FONT",
    "TIME", "DATA", "BR", "WBR",
  ]);

  // 纯噪音文本：URL / email / 路径 / 纯数字单位 / 纯符号，跳过不翻。
  const SKIP_TEXT_PATTERNS = [
    /^\s*$/,
    /^[\d\s.,:;!?@#$%^&*()\-_=+[\]{}|\\/<>~`'"]+$/, // 纯符号数字
    /^https?:\/\//i,
    /^www\./i,
    /^[\w.+-]+@[\w-]+\.[\w.-]+$/, // email
    /^[\d.]+(px|em|rem|%|pt|vh|vw|ms|s|kb|mb|gb)$/i, // 数字+单位
    /^#[0-9a-f]{3,8}$/i, // 颜色
  ];

  function isSkippableText(text) {
    const t = text.trim();
    if (t.length < 2) return true;
    return SKIP_TEXT_PATTERNS.some((re) => re.test(t));
  }

  function isHidden(el) {
    if (!el || !el.getBoundingClientRect) return false;
    // 优先用 offsetParent 快判（便宜）；display:none / 不在渲染树时为 null。
    if (el.offsetParent === null) {
      // position:fixed 元素 offsetParent 也为 null，需排除误判。
      const style = getComputedStyle(el);
      if (style.position !== "fixed") {
        if (style.display === "none" || style.visibility === "hidden") return true;
      }
    }
    return false;
  }

  function isExplicitlyExcluded(el) {
    if (el.getAttribute && el.getAttribute("translate") === "no") return true;
    if (el.classList && (el.classList.contains("notranslate") || el.classList.contains("lt-skip")))
      return true;
    // 我们自己注入的译文节点，绝不再次进入。
    if (el.dataset && el.dataset.ltInjected !== undefined) return true;
    return false;
  }

  // 判断一个元素是否应作为「叶子块」：它含有直接文本内容，且不应再下钻成更小的块。
  // 规则：元素是块级标签，且其子节点中存在非空文本 / 只含内联子元素。
  function isLeafBlock(el) {
    let hasText = false;
    let hasBlockChild = false;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue && child.nodeValue.trim()) hasText = true;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (SKIP_CONTAINER.has(tag)) continue;
        if (INLINE_TAGS.has(tag)) {
          // 内联子元素（如 <a> <span>）内部的文字也算作本块的文本。
          // 关键修复：许多网站标题/栏目标签的文字包在 <a> 里，
          // 如 <h3><a>标题</a></h3>，此处必须识别为叶子块，否则整块漏翻。
          if (child.textContent && child.textContent.trim()) hasText = true;
        } else if (isBlockLike(child)) {
          hasBlockChild = true;
        } else if (child.textContent && child.textContent.trim()) {
          // 非内联白名单、但实际为 inline 显示的未知元素：其文字也算本块文本。
          hasText = true;
        }
      }
    }
    // 含（直接或内联）文本 → 是叶子块；含块级子元素 → 继续下钻。
    return hasText && !hasBlockChild;
  }

  // 标签名快判 + getComputedStyle 兜底，判断是否块级显示。
  const _blockCache = new WeakMap();
  function isBlockLike(el) {
    if (_blockCache.has(el)) return _blockCache.get(el);
    let result;
    if (BLOCK_TAGS.has(el.tagName)) {
      result = true;
    } else if (INLINE_TAGS.has(el.tagName)) {
      result = false;
    } else {
      const display = getComputedStyle(el).display;
      result = !(display === "inline" || display === "inline-block" || display === "none");
    }
    _blockCache.set(el, result);
    return result;
  }

  // 从 root 收集所有「叶子块」元素。支持 Shadow DOM 与同源 iframe 穿透。
  // 返回 Element[]（每个都含可翻译文本、未被翻译过、可见）。
  function collectBlocks(root, acc = []) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SKIP_CONTAINER.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (isExplicitlyExcluded(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let el = walker.currentNode === root ? walker.nextNode() : walker.currentNode;
    // TreeWalker 不进入 shadow root / iframe，需手动递归。这里同时处理这两者。
    const pending = [];
    while (el) {
      // Shadow host：递归其 open shadowRoot。
      if (el.shadowRoot) pending.push(el.shadowRoot);
      // 同源 iframe：递归其 contentDocument（跨源会抛异常）。
      if (el.tagName === "IFRAME") {
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) pending.push(doc.body);
        } catch (_) {
          /* 跨源 iframe，安全跳过 */
        }
      }
      if (isCandidateBlock(el)) acc.push(el);
      el = walker.nextNode();
    }
    for (const sub of pending) collectBlocks(sub, acc);
    return acc;
  }

  function isCandidateBlock(el) {
    if (el.dataset && el.dataset.ltState) return false; // 已处理
    if (isHidden(el)) return false;
    if (!hasTranslatableText(el)) return false; // 至少有一段非 skip 文本才值得翻译

    if (isBlockLike(el)) {
      // 块级元素：必须是「叶子块」（含文本、无块级子元素）才作为翻译单元。
      return isLeafBlock(el);
    }
    // 内联元素：仅当它是「游离内联内容」时单独收集 —— 即它直接挂在一个
    // 含块级子元素的容器下（与块级兄弟并列，不属于任何叶子块）。
    // 例：<div><a class="category">SCIENCE</a><h3>..</h3><p>..</p></div>
    // 这能补回网站栏目标签/角标等夹在块之间的内联文字。
    return isOrphanInline(el);
  }

  // 判断内联元素是否为「游离内联内容」，作为独立翻译单元收集。条件：
  //   1. 父元素是块级，且父不是叶子块（父含块级子元素，会被下钻，此内联无人认领）；
  //   2. 该内联自身不含块级子元素 —— 否则其内部块级元素（如 <a><h2>标题</h2></a>
  //      里的 <h2>）会各自被收集，若再把外层 <a> 也收集，同一文字会被翻译两次。
  function isOrphanInline(el) {
    const parent = el.parentElement;
    if (!parent) return false;
    if (!isBlockLike(parent)) return false; // 只取直接挂在块下的最外层内联
    if (isLeafBlock(parent)) return false; // 父是叶子块 → 随父一起序列化，勿重复
    if (containsBlock(el)) return false; // 自身含块级子孙 → 交给那些块，勿重复收集
    return true;
  }

  // 该元素的子孙中是否存在块级元素（用于判断内联是否"纯文本/纯内联"）。
  function containsBlock(el) {
    for (const child of el.children) {
      if (SKIP_CONTAINER.has(child.tagName)) continue;
      if (isBlockLike(child)) return true;
      if (containsBlock(child)) return true;
    }
    return false;
  }

  function hasTranslatableText(el) {
    let combined = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) combined += child.nodeValue;
      else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_CONTAINER.has(child.tagName))
        combined += child.textContent;
    }
    return !isSkippableText(combined) && /[\p{L}]/u.test(combined);
  }

  LT.domWalker = {
    collectBlocks,
    isCandidateBlock,
    isHidden,
    isSkippableText,
    SKIP_CONTAINER,
    BLOCK_TAGS,
    INLINE_TAGS,
  };
})();
