export const generationTools = {
  video: "node:generateVideo",
  image: "node:generateImage",
  audio: "node:generateAudio",
  text: "node:generate",
} as const;

export type Kind = keyof typeof generationTools;
type Call = (id: string, name: string, signal?: AbortSignal) => Promise<unknown>;
type Target = { id: string; kind: Kind };
type Status = { status?: string; state?: string; error?: string; lastError?: string; generating?: boolean; textLength?: number; task?: { state?: string } };

export function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function generateTarget(
  target: Target,
  call: Call,
  signal: AbortSignal,
  started: Set<string>,
  options: { hasStatus: boolean; hasTextOutput: () => boolean; delay?: number; timeout?: number },
) {
  const { id, kind } = target;
  const isText = kind === "text";
  const statusTool = isText ? "node:getState" : "node:getGenerationStatus";
  const deadline = Date.now() + (options.timeout ?? 3_600_000);
  const readStatus = async () => (await call(id, statusTool, signal) ?? {}) as Status;
  const before = options.hasStatus ? await readStatus() : {};
  const currentState = (result: Status) => result.status ?? result.state;
  const wasRunning = before.generating || currentState(before) === "running" || currentState(before) === "generating";
  const recovering = !isText && !!before.task && before.task.state !== "failed";

  try {
    if (!wasRunning) {
      signal.throwIfAborted();
      if (!recovering) started.add(id);
      const result = (await call(id, generationTools[kind], signal) ?? {}) as Status;
      const state = currentState(result);
      if (result.error || state === "failed") throw new Error(result.error || "提交失败");
      if (isText && state !== "running" && state !== "generating" && !result.generating
          && (Number(result.textLength) > 0 || state === "succeeded")) return;
      if (isText && !options.hasStatus) {
        if (options.hasTextOutput()) return;
        throw new Error("节点未返回可确认的文本结果");
      }
    }

    let idleCount = 0;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const result = await readStatus();
      const state = currentState(result);
      const error = result.error || result.lastError;
      if (state === "failed" || (!result.generating && isText && error)) throw new Error(error || "生成失败");
      if (state === "succeeded" || (isText && !result.generating && Number(result.textLength) > 0)) return;
      idleCount = state === "idle" || (isText && !result.generating) ? idleCount + 1 : 0;
      if (idleCount >= 4) throw new Error("未收到生成成功状态，请检查节点");
      await sleep(options.delay ?? 1_200, signal);
    }
    throw new Error("等待生成超时，请核对节点任务");
  } finally {
    if (!signal.aborted) started.delete(id);
  }
}
