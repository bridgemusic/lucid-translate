// 批处理队列（content 侧）。
// 把懒翻译产生的零散段落贪心打包，按三阈值 flush，发给 background 翻译，
// 再按 id 把译文回填到对应段落（绝不按顺序回填）。挂到 window.LT。

(function () {
  const LT = (window.LT = window.LT || {});

  const LIMITS = {
    maxSegments: 12, // 单批最多段落数
    maxChars: 2400, // 单批字符上限（防超 token）
    maxWaitMs: 120, // 凑批最大等待，保证及时
    maxConcurrent: 6, // 同时在飞的批次数（吞吐与限流的平衡）
    maxRetries: 3, // 单批失败的最大重试次数
    retryBaseMs: 600, // 重试退避基数（指数退避 + 抖动）
  };

  // sendBatch(segments) => Promise<{id, text}[]>，由 content 注入（走 background）。
  function createQueue(sendBatch, limits = {}) {
    const cfg = { ...LIMITS, ...limits };
    let buffer = []; // { id, text, resolve, reject }
    let bufferChars = 0;
    let timer = null;
    let inFlight = 0;
    const waiting = []; // 并发受限时排队的批

    function enqueue(seg) {
      return new Promise((resolve, reject) => {
        buffer.push({ ...seg, resolve, reject });
        bufferChars += seg.text.length;
        if (buffer.length >= cfg.maxSegments || bufferChars >= cfg.maxChars) {
          flush();
        } else if (!timer) {
          timer = setTimeout(flush, cfg.maxWaitMs);
        }
      });
    }

    function flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      bufferChars = 0;
      dispatch(batch, 0);
    }

    // 是否值得重试的错误：限流、超时、5xx、网络、JSON 解析等瞬时问题都重试；
    // 401/403（鉴权）这类确定性错误不重试，避免无谓等待。
    function isRetryable(err) {
      const m = String((err && err.message) || err || "");
      if (/\b(401|403)\b/.test(m)) return false;
      if (/NO_API_KEY/.test(m)) return false;
      return true;
    }

    function backoffDelay(attempt) {
      // 指数退避 + 抖动：600ms, 1200ms, 2400ms (±25%)
      const base = cfg.retryBaseMs * Math.pow(2, attempt);
      return base + base * 0.5 * (Math.random() - 0.5);
    }

    function dispatch(batch, attempt) {
      if (inFlight >= cfg.maxConcurrent) {
        waiting.push({ batch, attempt });
        return;
      }
      inFlight++;
      const segments = batch.map((b) => ({ id: b.id, text: b.text }));
      sendBatch(segments)
        .then((results) => {
          const byId = new Map();
          for (const r of results || []) byId.set(r.id, r.text);
          const resolved = [];
          const missing = [];
          for (const item of batch) {
            if (byId.has(item.id)) {
              item.resolve(byId.get(item.id));
              resolved.push(item);
            } else {
              missing.push(item);
            }
          }
          // 部分缺失：只对缺失的段重试（不连累已成功的段），
          // 这能挽救模型偶尔漏返、数量不符的情况。
          if (missing.length) {
            if (attempt < cfg.maxRetries) {
              scheduleRetry(missing, attempt + 1);
            } else {
              for (const item of missing) {
                item.reject(new Error("missing translation for id " + item.id));
              }
            }
          }
        })
        .catch((err) => {
          // 整批失败：可重试错误则退避重试，否则全部 reject。
          if (isRetryable(err) && attempt < cfg.maxRetries) {
            scheduleRetry(batch, attempt + 1);
          } else {
            for (const item of batch) item.reject(err);
          }
        })
        .finally(() => {
          inFlight--;
          drainWaiting();
        });
    }

    function scheduleRetry(batch, attempt) {
      setTimeout(() => dispatch(batch, attempt), backoffDelay(attempt - 1));
    }

    function drainWaiting() {
      while (waiting.length && inFlight < cfg.maxConcurrent) {
        const { batch, attempt } = waiting.shift();
        dispatch(batch, attempt);
      }
    }

    return { enqueue, flush };
  }

  LT.batchQueue = { createQueue, LIMITS };
})();
