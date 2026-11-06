import { describe, expect, test } from "bun:test";
import { arrangeQueue, executeQueue } from "./queue";
import { generateTarget } from "./generation";
import { quoteRequest, totalQuote } from "./quote";

const item = (id: string, x = 0) => ({ id, x, y: 0 });

describe("批次计划", () => {
  test("跨过中间节点，且层内从左到右", () => {
    const plan = arrangeQueue([item("C"), item("B", 40), item("A", 10)], [
      { source: "A", target: "桥接" }, { source: "桥接", target: "C" },
    ]);
    expect(plan.layers.map(layer => layer.map(row => row.id))).toEqual([["A", "B"], ["C"]]);
  });
  test("拒绝循环依赖", () => {
    expect(() => arrangeQueue([item("A"), item("B")], [
      { source: "A", target: "B" }, { source: "B", target: "A" },
    ])).toThrow("循环依赖");
  });
  test("同层照常完成，失败后停止提交后续层并标注后代", async () => {
    const plan = arrangeQueue(["A", "B", "C", "D", "E"].map(id => item(id)), [
      { source: "A", target: "C" }, { source: "C", target: "D" }, { source: "B", target: "E" },
    ]);
    const called: string[] = [];
    const result = await executeQueue(plan, new AbortController().signal, async row => {
      called.push(row.id);
      if (row.id === "A") throw new Error("模拟失败");
    }, () => {});
    expect(called).toEqual(["A", "B"]);
    expect([...result.values()].map(entry => entry.state)).toEqual(["failed", "done", "blocked", "skipped", "blocked"]);
  });
});

describe("生成状态", () => {
  const target = { id: "A", kind: "video" } as const;
  const options = { hasStatus: true, hasTextOutput: () => false, delay: 0 };
  test("等到宿主返回成功状态", async () => {
    const states = ["idle", "running", "succeeded"];
    const calls: string[] = [];
    await generateTarget(target, async (_id, name) => {
      calls.push(name);
      return { status: name === "node:generateVideo" ? "generating" : states.shift() };
    }, new AbortController().signal, new Set(), options);
    expect(calls).toEqual(["node:getGenerationStatus", "node:generateVideo", "node:getGenerationStatus", "node:getGenerationStatus"]);
  });
  test("已有任务只等待一次，提交错误和缺少终态都报失败", async () => {
    const calls: string[] = [];
    let read = 0;
    await generateTarget(target, async (_id, name) => {
      calls.push(name);
      return { status: ++read === 1 ? "running" : "succeeded" };
    }, new AbortController().signal, new Set(), options);
    expect(calls).toEqual(["node:getGenerationStatus", "node:getGenerationStatus"]);

    await expect(generateTarget(target, async (_id, name) => {
      if (name === "node:generateVideo") throw new Error("模拟拒绝");
      return { status: "idle" };
    }, new AbortController().signal, new Set(), options)).rejects.toThrow("模拟拒绝");

    await expect(generateTarget(target, async () => ({ status: "idle" }),
      new AbortController().signal, new Set(), options)).rejects.toThrow("未收到生成成功状态");
  });
});

test("报价根据当前配置计算并明确区分部分估价", () => {
  const request = quoteRequest("video", "A", { model: '["test","video"]', duration: "6", generateAudio: false },
    "/mock", [{ dataType: "AUDIO", value: { url: "assets/test.wav", mimeType: "audio/wav" } }]);
  expect(request).toMatchObject({ modelId: "video", duration: 6, generateAudio: false, audios: [{ path: "assets/test.wav" }] });
  expect(totalQuote(["约1.17元", "约0.83元"], 2)).toBe("约 2 元");
  expect(totalQuote(["约1.17元"], 2)).toBe("约 1.17 元（已估 1/2）");
  const frameQuote = quoteRequest("video", "A", { model: '["test","video"]', mode: '"startFrameOptional"' },
    "/mock", [{ dataType: "IMAGE", value: { url: "assets/end.png", mimeType: "image/png" } }]);
  expect(frameQuote).toMatchObject({ mode: "startFrameOptional", firstFrame: undefined,
    lastFrame: { path: "assets/end.png" }, referenceOrder: [{ type: "lastFrame" }] });
});
