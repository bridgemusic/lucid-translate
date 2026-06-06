// 懒翻译调度（IntersectionObserver）+ SPA 增量翻译（MutationObserver）。
// 关键防护：防自我死循环（skipMoNodes）、去重（observedNodes）、stale 检查。
// 挂到 window.LT。

(function () {
  const LT = (window.LT = window.LT || {});

  // 创建一套观察器。
  //   onBlockVisible(el): 块进入视口时调用（触发翻译）。
  //   markInjected(node): 由 content 提供，标记「我们自己插入的节点」（见 isOurNode）。
  function createObservers({ onBlockVisible }) {
    const observedNodes = new WeakSet(); // 已交给 IO 观察 / 已处理，避免重复
    const skipMoNodes = new WeakSet(); // 我们自己注入的节点，MutationObserver 跳过

    let io = null;
    let mo = null;
    let active = false;

    function ensureIO() {
      if (io) return io;
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            io.unobserve(el);
            if (!el.isConnected) continue; // stale：SPA 已移除
            onBlockVisible(el);
          }
        },
        // 提前约两屏开始翻译：滚动时下方内容大概率已译好，体感更顺。
        { rootMargin: "1200px 0px" }
      );
      return io;
    }

    // 观察一批块元素（懒翻译）。
    function observeBlocks(blocks) {
      const o = ensureIO();
      for (const el of blocks) {
        if (observedNodes.has(el)) continue;
        observedNodes.add(el);
        o.observe(el);
      }
    }

    // 标记我们注入的节点，使其在 MutationObserver 回调里被忽略（防死循环）。
    function markInjected(node) {
      skipMoNodes.add(node);
    }

    function isOurMutation(node) {
      // 注入节点本身或其祖先被标记，则视为自我变更。
      let n = node;
      while (n) {
        if (skipMoNodes.has(n)) return true;
        n = n.parentNode || (n.getRootNode && n.getRootNode().host) || null;
      }
      return false;
    }

    // 启动 SPA 增量监听。onNewContent(rootEl) 由 content 提供，
    // 用于对新增子树重新做块切分 + observeBlocks。
    function startMutationObserver(onNewContent) {
      if (mo) return;
      mo = new MutationObserver((mutations) => {
        const roots = new Set();
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (isOurMutation(node)) continue; // 跳过自己注入的译文
            roots.add(node);
          }
        }
        if (roots.size) {
          // 去掉互为后代的根，避免重复扫描。
          const top = [];
          for (const r of roots) {
            let nested = false;
            for (const other of roots) {
              if (other !== r && other.contains(r)) {
                nested = true;
                break;
              }
            }
            if (!nested) top.push(r);
          }
          for (const r of top) onNewContent(r);
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // SPA 路由变化（pushState/popState）后重新全量扫描。
    function hookHistory(onRouteChange) {
      const fire = () => {
        // 微延迟等新视图挂载完成。
        setTimeout(onRouteChange, 150);
      };
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (...args) {
        const r = origPush.apply(this, args);
        fire();
        return r;
      };
      history.replaceState = function (...args) {
        const r = origReplace.apply(this, args);
        fire();
        return r;
      };
      window.addEventListener("popstate", fire);
    }

    function start() {
      active = true;
    }

    function stop() {
      active = false;
      if (io) {
        io.disconnect();
        io = null;
      }
      if (mo) {
        mo.disconnect();
        mo = null;
      }
    }

    function isActive() {
      return active;
    }

    return {
      observeBlocks,
      markInjected,
      startMutationObserver,
      hookHistory,
      start,
      stop,
      isActive,
    };
  }

  LT.observers = { createObservers };
})();
