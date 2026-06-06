// 批处理队列回归测试：id 对齐回填、指数退避重试、部分缺失只补缺失段、鉴权不重试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnv } from "./helpers.js";

// 仅需 batch-queue 库。
function makeQueue(sendBatch, limits) {
  const { LT } = createEnv({ libs: ["lib/batch-queue.js"] });
  return LT.batchQueue.createQueue(sendBatch, { maxWaitMs: 5, retryBaseMs: 10, ...limits });
}

test("id 对齐回填：返回乱序也按 id 正确分发", async () => {
  const q = makeQueue(async (segs) =>
    segs.map((s) => ({ id: s.id, text: "T" + s.id })).reverse()
  );
  const [a, b, c] = await Promise.all([
    q.enqueue({ id: 0, text: "a" }),
    q.enqueue({ id: 1, text: "b" }),
    q.enqueue({ id: 2, text: "c" }),
  ]);
  assert.equal(a, "T0");
  assert.equal(b, "T1");
  assert.equal(c, "T2");
});

test("瞬时失败（网络抖动）后自动重试成功", async () => {
  let calls = 0;
  const q = makeQueue(async (segs) => {
    calls++;
    if (calls <= 2) throw new Error("Failed to fetch");
    return segs.map((s) => ({ id: s.id, text: "T" + s.id }));
  });
  const r = await q.enqueue({ id: 0, text: "x" });
  assert.equal(r, "T0");
  assert.equal(calls, 3, "应重试到第 3 次成功");
});

test("鉴权错误（401）不重试，立即失败", async () => {
  let calls = 0;
  const q = makeQueue(async () => {
    calls++;
    throw new Error("HTTP 401: invalid key");
  });
  await assert.rejects(q.enqueue({ id: 0, text: "x" }));
  assert.equal(calls, 1, "401 不应重试");
});

test("部分缺失：成功段立即返回，仅缺失段重试", async () => {
  let calls = 0;
  const q = makeQueue(
    async (segs) => {
      calls++;
      if (calls === 1) return segs.filter((s) => s.id === 0).map((s) => ({ id: s.id, text: "T" + s.id }));
      return segs.map((s) => ({ id: s.id, text: "R" + s.id }));
    },
    { maxSegments: 10 }
  );
  const [v0, v1] = await Promise.all([
    q.enqueue({ id: 0, text: "a" }),
    q.enqueue({ id: 1, text: "b" }),
  ]);
  assert.equal(v0, "T0", "成功段应来自首次响应");
  assert.equal(v1, "R1", "缺失段应来自重试响应");
});

test("持续失败：重试到上限后最终 reject", async () => {
  let calls = 0;
  const q = makeQueue(
    async () => {
      calls++;
      throw new Error("HTTP 500");
    },
    { maxRetries: 3 }
  );
  await assert.rejects(q.enqueue({ id: 0, text: "x" }));
  assert.equal(calls, 4, "1 次初试 + 3 次重试");
});

test("并发受限：超出 maxConcurrent 的批次排队后仍全部完成", async () => {
  let active = 0;
  let maxActive = 0;
  const q = makeQueue(
    async (segs) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return segs.map((s) => ({ id: s.id, text: "T" + s.id }));
    },
    { maxConcurrent: 2, maxSegments: 1 }
  );
  const results = await Promise.all(
    [0, 1, 2, 3, 4].map((id) => q.enqueue({ id, text: "s" + id }))
  );
  assert.deepEqual(results, ["T0", "T1", "T2", "T3", "T4"], "全部应完成");
  assert.ok(maxActive <= 2, `并发不应超过 2，实际峰值 ${maxActive}`);
});
