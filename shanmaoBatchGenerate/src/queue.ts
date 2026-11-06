export type Link = { source: string; target: string };
export type QueueItem = { id: string; x: number; y: number };
export type QueuePlan<T> = { layers: T[][]; prerequisites: Map<string, Set<string>> };
export type QueueState = "waiting" | "running" | "done" | "failed" | "blocked" | "skipped";
export type QueueResult = { state: QueueState; detail?: string };

export function arrangeQueue<T extends QueueItem>(items: T[], links: Link[]): QueuePlan<T> {
  const chosen = new Set(items.map(item => item.id));
  const incoming = new Map<string, Set<string>>();
  for (const { source, target } of links) {
    if (!incoming.has(target)) incoming.set(target, new Set());
    incoming.get(target)!.add(source);
  }

  const prerequisites = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const pending = new Map<string, number>();
  for (const item of items) {
    const needed = new Set<string>();
    const visited = new Set<string>();
    const search = [...(incoming.get(item.id) ?? [])];
    while (search.length) {
      const source = search.pop()!;
      if (visited.has(source)) continue;
      visited.add(source);
      if (chosen.has(source)) needed.add(source);
      else for (const upstream of incoming.get(source) ?? []) search.push(upstream);
    }
    prerequisites.set(item.id, needed);
    pending.set(item.id, needed.size);
    for (const source of needed) {
      if (!dependents.has(source)) dependents.set(source, new Set());
      dependents.get(source)!.add(item.id);
    }
  }

  const byId = new Map(items.map(item => [item.id, item]));
  const layers: T[][] = [];
  let ready = items.filter(item => !pending.get(item.id));
  let placed = 0;
  while (ready.length) {
    ready.sort((left, right) => left.x - right.x || left.y - right.y || left.id.localeCompare(right.id));
    layers.push(ready);
    placed += ready.length;
    const next: T[] = [];
    for (const item of ready) {
      for (const id of dependents.get(item.id) ?? []) {
        const count = pending.get(id)! - 1;
        pending.set(id, count);
        if (count === 0) next.push(byId.get(id)!);
      }
    }
    ready = next;
  }
  if (placed !== items.length) throw new Error("选中的节点存在循环依赖，请检查连线");
  return { layers, prerequisites };
}

export async function executeQueue<T extends QueueItem>(
  plan: QueuePlan<T>,
  signal: AbortSignal,
  execute: (item: T) => Promise<void>,
  report: (item: T, result: QueueResult) => void,
) {
  const results = new Map<string, QueueResult>();
  const record = (item: T, result: QueueResult) => {
    results.set(item.id, result);
    report(item, result);
  };
  let failed = false;
  for (const layer of plan.layers) {
    if (signal.aborted || failed) break;
    await Promise.all(layer.map(async item => {
      record(item, { state: "running" });
      try {
        await execute(item);
        record(item, signal.aborted ? { state: "skipped", detail: "已停止" } : { state: "done" });
      } catch (error) {
        if (signal.aborted) record(item, { state: "skipped", detail: "已停止" });
        else {
          failed = true;
          record(item, { state: "failed", detail: error instanceof Error ? error.message : String(error) });
        }
      }
    }));
  }
  for (const item of plan.layers.flat()) {
    if (results.has(item.id)) continue;
    const blocked = [...(plan.prerequisites.get(item.id) ?? [])].some(id => {
      const state = results.get(id)?.state;
      return state === "failed" || state === "blocked";
    });
    record(item, blocked ? { state: "blocked", detail: "上游失败" }
      : { state: "skipped", detail: signal.aborted ? "已停止" : "因失败未提交" });
  }
  return results;
}
