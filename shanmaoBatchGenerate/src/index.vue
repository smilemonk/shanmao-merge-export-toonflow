<script lang="ts">
const runningCanvases = new WeakSet<object>();
const toolbarOwners = new WeakMap<HTMLElement, HTMLElement>();
</script>

<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { nodeSkeleton as NodeSkeleton, useNode, useNodeInputs, useNodeToolsContext, z } from "@toonflow/nodes-scaffold/runtime";
import { arrangeQueue, executeQueue, type QueueResult } from "./queue";
import { generateTarget, generationTools, type Kind } from "./generation";
import { modelChoice, quoteRequest, totalQuote } from "./quote";

defineOptions({ inheritAttrs: false });

const { node, nodeProps, nodeTools, nodeEvent, ai } = useNode({ label: "批量生成" });
const flow = useVueFlow();
const inputs = useNodeInputs(flow);
const getTools = useNodeToolsContext();
const getDirectory = inject<() => string>("workspaceDirectory");
const canvasKey = flow.getNodes;
const kinds = ["video", "image", "audio", "text"] as const;
const captions = { video: "视频", image: "图片", audio: "音频", text: "文本" };
const sortOrder: Kind[] = ["video", "image", "text", "audio"];
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });
type PanelSettings = { shanmaoBatchGenerate?: { expanded: boolean } };
const panelSettings = () => node.data as typeof node.data & PanelSettings;
const expanded = ref(panelSettings().shanmaoBatchGenerate?.expanded !== false);
const checked = ref(new Set<string>());
const registryVersion = ref(getTools().version);
const jobs = ref<Record<string, QueueResult>>({});
const runIds = ref<string[]>([]);
const status = ref("");
const running = ref(false);
const failed = ref(false);
let current: AbortController | undefined;
let disposed = false;

const allNodes = computed(() => new Map(flow.getNodes.value.map(item => [item.id, item])));
const links = computed(() => flow.getEdges.value.map(({ source, target }) => ({ source, target })));
const actions = computed(() => {
  registryVersion.value;
  const byId = new Map<string, Set<string>>();
  for (const info of getTools().list([...allNodes.value.keys()])) {
    if (!byId.has(info.nodeId)) byId.set(info.nodeId, new Set());
    byId.get(info.nodeId)!.add(info.name);
  }
  return byId;
});

function hasOutput(item: { data: Record<string, any> }, kind: Kind) {
  return Object.values(item.data.outputs ?? {}).some(output => {
    const entry = output as { dataType?: string; value?: unknown } | undefined;
    if (kind === "text") return typeof entry?.value === "string" && !!entry.value.trim();
    if (!entry || entry.dataType !== kind.toUpperCase()) return false;
    const value = entry.value as { url?: string } | undefined;
    return !!value?.url;
  });
}

const rows = computed(() => [...allNodes.value.values()].flatMap(item => {
  const capabilities = actions.value.get(item.id);
  const kind = kinds.find(type => capabilities?.has(generationTools[type]));
  if (!kind) return [];
  const position = item.computedPosition ?? item.position;
  const choice = modelChoice(item.data.model ?? item.data);
  const model = choice ? `${choice.providerId} / ${choice.modelId}` : "";
  const params = [item.data.resolution ?? item.data.size, item.data.ratio, item.data.duration ? `${item.data.duration}s` : "", item.data.format]
    .filter(Boolean).join(" · ");
  return [{ id: item.id, label: String(item.data.label ?? item.label ?? item.id), kind, model, params,
    hasResult: hasOutput(item, kind), x: position.x, y: position.y }];
}).sort((left, right) => sortOrder.indexOf(left.kind) - sortOrder.indexOf(right.kind)
  || collator.compare(left.label, right.label) || left.id.localeCompare(right.id)));
type Row = typeof rows.value[number];

const layout = computed(() => {
  try {
    const plan = arrangeQueue(rows.value, links.value);
    return new Map(plan.layers.flatMap((layer, i) => layer.map(row => [row.id, i + 1])));
  } catch { return new Map<string, number>(); }
});
const selected = computed(() => rows.value.filter(row => checked.value.has(row.id)));
const selectedSummary = computed(() => sortOrder.map(kind => {
  const count = selected.value.filter(row => row.kind === kind).length;
  return count ? `${count}${captions[kind]}` : "";
}).filter(Boolean).join("、") || "0");
const groups = computed(() => ({
  ...Object.fromEntries(kinds.map(kind => [kind, rows.value.filter(row => row.kind === kind)])),
  new: rows.value.filter(row => !row.hasResult),
}) as Record<Kind | "new", Row[]>);
const progress = computed(() => runIds.value.filter(id => jobs.value[id] && !["waiting", "running"].includes(jobs.value[id].state)).length);

function toggle(id: string, value: boolean) {
  if (value) checked.value.add(id); else checked.value.delete(id);
}
function groupCount(group: Kind | "new") {
  return groups.value[group].filter(row => checked.value.has(row.id)).length;
}
function toggleGroup(group: Kind | "new") {
  const members = groups.value[group];
  const value = groupCount(group) !== members.length;
  for (const member of members) toggle(member.id, value);
}
function toggleExpanded() {
  expanded.value = !expanded.value;
  panelSettings().shanmaoBatchGenerate = { expanded: expanded.value };
}
function checkedInput(event: Event) { return (event.target as HTMLInputElement).checked; }
function displayStatus(row: Row) {
  const result = jobs.value[row.id];
  if (!result) return row.hasResult ? "已生成" : "";
  const labels = { waiting: "等待", running: "执行中", done: "完成", failed: "失败", blocked: "上游失败", skipped: "跳过" };
  return labels[result.state];
}

const quoteState = ref("");
const quoteJobs = computed(() => {
  let directory = "";
  try { directory = getDirectory?.() ?? ""; } catch {}
  return selected.value.filter(row => row.kind !== "text").map(row => {
    const item = allNodes.value.get(row.id);
    if (!item || row.kind === "text") return;
    try {
      const ports = (item.data.handles ?? []).filter((port: { type: string }) => port.type === "target");
      const refs = ports.flatMap((port: { id: string }) => {
        const order: string[] = item.data.referenceOrder?.[port.id] ?? [];
        const index = new Map(order.map((key, i) => [key, i]));
        const rank = (ref: { source: string; sourceHandle: string }) => index.get(encodeURIComponent(JSON.stringify([ref.source, ref.sourceHandle]))) ?? index.size;
        return [...inputs.getTargetValues(row.id, port.id)].sort((a, b) => rank(a) - rank(b));
      });
      return quoteRequest(row.kind, row.id, item.data, directory, refs);
    } catch { return undefined; }
  });
});
watch(() => JSON.stringify(quoteJobs.value), (serialized, _previous, cleanup) => {
  const requests: typeof quoteJobs.value = JSON.parse(serialized);
  quoteState.value = requests.length ? "估价中…" : "";
  if (!requests.length) return;
  const controller = new AbortController();
  const timer = setTimeout(async () => {
    const prices: string[] = [];
    let index = 0;
    const worker = async () => {
      while (index < requests.length && !controller.signal.aborted) {
        const request = requests[index++];
        if (!request) continue;
        try {
          const result = await ai.getMediaPrice(request, controller.signal);
          if (result) prices.push(result.price);
        } catch { /* 估价不可用时保留其余报价 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, requests.length) }, worker));
    if (!controller.signal.aborted) quoteState.value = totalQuote(prices, requests.length);
  }, 400);
  cleanup(() => { clearTimeout(timer); controller.abort(); });
}, { immediate: true });
const quoteLabel = computed(() => quoteState.value || (selected.value.length ? "文本节点单独计费" : "—"));

function expandGroups(ids: string[]) {
  const found = new Set(ids);
  const children = new Map<string, string[]>();
  for (const item of allNodes.value.values()) {
    if (!item.parentNode) continue;
    if (!children.has(item.parentNode)) children.set(item.parentNode, []);
    children.get(item.parentNode)!.push(item.id);
  }
  const pending = ids.filter(id => allNodes.value.get(id)?.type === "canvasGroup");
  while (pending.length) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      pending.push(child);
    }
  }
  return found;
}

const dialog = ref<HTMLDialogElement>();
const dialogRows = ref<Row[]>([]);
const ignored = ref<string[]>([]);
const dialogChecks = ref(new Set<string>());
const dialogConfirmed = ref(false);
function openDialog(candidates: Row[], unavailable: string[], reason: "selection" | "large") {
  dialogRows.value = candidates;
  ignored.value = unavailable;
  dialogChecks.value = new Set(reason === "large" ? candidates.map(row => row.id) : []);
  dialogConfirmed.value = false;
  if (dialog.value && !dialog.value.open) dialog.value.showModal();
}
function showCanvasSelection() {
  const ids = expandGroups(flow.getSelectedNodes.value.map(item => item.id));
  const candidates = rows.value.filter(row => ids.has(row.id));
  const runnable = new Set(candidates.map(row => row.id));
  const unavailable = [...ids].filter(id => !runnable.has(id)).flatMap(id => {
    const item = allNodes.value.get(id);
    return item && item.type !== "canvasGroup" ? [String(item.data.label ?? item.label ?? id)] : [];
  });
  openDialog(candidates, unavailable, "selection");
}
function toggleDialog(id: string, value: boolean) {
  if (value) dialogChecks.value.add(id); else dialogChecks.value.delete(id);
}
function toggleDialogAll(value: boolean) {
  dialogChecks.value = new Set(value ? dialogRows.value.map(row => row.id) : []);
}
const dialogSelected = computed(() => dialogRows.value.filter(row => dialogChecks.value.has(row.id)));
const missingUpstream = computed(() => {
  const chosen = new Set(dialogSelected.value.map(row => row.id));
  const missing = new Set(rows.value.filter(row => !row.hasResult && !chosen.has(row.id)).map(row => row.id));
  return new Set(links.value.filter(link => chosen.has(link.target) && missing.has(link.source)).map(link => link.target)).size;
});
function acceptDialog() {
  if (!dialogSelected.value.length || (dialogSelected.value.length >= 15 && !dialogConfirmed.value)) return;
  checked.value = new Set(dialogSelected.value.map(row => row.id));
  dialog.value?.close();
  void submit(dialogSelected.value).catch(showError);
}
function startPanel() {
  if (selected.value.length >= 15) openDialog(selected.value, [], "large");
  else void submit(selected.value).catch(showError);
}

function showError(error: unknown) {
  failed.value = true;
  status.value = error instanceof Error ? error.message : String(error);
}
const started = new Set<string>();
const call = (id: string, name: string, signal?: AbortSignal) => getTools().call({ nodeId: id, name: name as `node:${string}`, args: {} }, signal);

async function submit(candidates: Row[], external?: AbortSignal) {
  if (runningCanvases.has(canvasKey)) throw new Error("这张画布已有一批任务在执行");
  if (!candidates.length) throw new Error("请先勾选要执行的节点");
  const plan = arrangeQueue(candidates, links.value);
  runningCanvases.add(canvasKey);
  const controller = new AbortController();
  current = controller;
  const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
  started.clear();
  runIds.value = plan.layers.flat().map(row => row.id);
  jobs.value = Object.fromEntries(runIds.value.map(id => [id, { state: "waiting" as const }]));
  status.value = "";
  failed.value = false;
  running.value = true;
  try {
    const results = await executeQueue(plan, signal, async row => {
      const item = flow.findNode(row.id);
      if (!item) throw new Error("节点已从画布移除");
      const statusTool = row.kind === "text" ? "node:getState" : "node:getGenerationStatus";
      const hasStatus = [...getTools().list([row.id], [statusTool])].length > 0;
      if (!hasStatus && row.kind !== "text") throw new Error("这个节点没有可用的生成状态接口");
      await generateTarget(row, call, signal, started, { hasStatus, hasTextOutput: () => hasOutput(item, row.kind) });
    }, (row, result) => { jobs.value[row.id] = result; });
    const count = (state: QueueResult["state"]) => [...results.values()].filter(result => result.state === state).length;
    const summary = { total: candidates.length, done: count("done"), failed: count("failed"), blocked: count("blocked"), skipped: count("skipped"),
      stopped: signal.aborted, layers: plan.layers.length, results: [...results].map(([nodeId, result]) => ({ nodeId, ...result })) };
    failed.value = summary.failed + summary.blocked > 0;
    status.value = [`完成 ${summary.done} 个`, summary.failed ? `失败 ${summary.failed}` : "", summary.blocked ? `上游失败 ${summary.blocked}` : "",
      summary.skipped ? `跳过 ${summary.skipped}` : "", summary.stopped ? "已停止" : "", `共 ${summary.layers} 层`].filter(Boolean).join(" · ");
    return summary;
  } finally {
    started.clear();
    current = undefined;
    running.value = false;
    runningCanvases.delete(canvasKey);
  }
}

async function stop() {
  if (!current || current.signal.aborted) return;
  const targets = [...started];
  status.value = "正在停止…";
  current.abort(new Error("已停止"));
  await Promise.allSettled(targets.map(id => call(id, "node:cancelGeneration")));
}

nodeTools.register({
  name: "inspectQueue",
  description: "读取当前画布可执行节点、类型、依赖层和已有结果",
  parameters: z.strictObject({}),
  execute: () => ({ running: running.value, tasks: rows.value.map(row => ({ ...row, layer: layout.value.get(row.id), state: jobs.value[row.id]?.state ?? "idle" })) }),
});
nodeTools.register({
  name: "startQueue",
  description: "只执行明确提供的节点。会使用这些节点现有参数，可能产生费用或覆盖结果。",
  parameters: z.strictObject({ nodeIds: z.array(z.string().min(1)).min(1), confirm: z.literal(true) }),
  async execute({ nodeIds }, { signal }) {
    const ids = expandGroups(nodeIds);
    const runnable = rows.value.filter(row => ids.has(row.id));
    if (!runnable.length) throw new Error("清单里没有可执行的节点");
    return submit(runnable, signal);
  },
});
nodeEvent.on("save", reason => {
  if (reason === "reload" && running.value) throw new Error("批量任务正在执行，请完成或停止后再刷新");
});

const toolbar = shallowRef<HTMLElement>();
const panel = ref<HTMLElement>();
let observer: MutationObserver | undefined;
let registryTimer: ReturnType<typeof setInterval> | undefined;
let canvasElement: HTMLElement | undefined;
function syncToolbar() {
  if (disposed || !canvasElement || !panel.value) return;
  const owner = toolbarOwners.get(canvasElement);
  if (owner?.isConnected && owner !== panel.value) { toolbar.value = undefined; return; }
  const target = canvasElement.querySelector<HTMLElement>(".selectionToolbar .toolbarActions") ?? undefined;
  if (target) toolbarOwners.set(canvasElement, panel.value);
  if (toolbar.value !== target) toolbar.value = target;
}
watch(panel, element => {
  observer?.disconnect();
  if (canvasElement && !toolbarOwners.get(canvasElement)?.isConnected) toolbarOwners.delete(canvasElement);
  canvasElement = element?.closest<HTMLElement>(".canvas") ?? flow.vueFlowRef.value ?? undefined;
  if (!canvasElement || !element) return;
  observer = new MutationObserver(syncToolbar);
  observer.observe(canvasElement, { childList: true, subtree: true });
  syncToolbar();
}, { flush: "post" });
watch(() => flow.getSelectedNodes.value, syncToolbar, { flush: "post" });
onMounted(() => {
  registryVersion.value = getTools().version;
  registryTimer = setInterval(() => { registryVersion.value = getTools().version; }, 1_500);
});
onScopeDispose(() => {
  disposed = true;
  observer?.disconnect();
  clearInterval(registryTimer);
  if (canvasElement && toolbarOwners.get(canvasElement) === panel.value) toolbarOwners.delete(canvasElement);
  current?.abort(new Error("已离开画布"));
});
</script>

<template>
  <NodeSkeleton v-bind="nodeProps" class="shanmao-batch-generate">
    <div ref="panel" class="shanmao-panel nopan nowheel">
      <div class="shanmao-summary">
        <span v-if="running">执行中 <b>{{ progress }} / {{ runIds.length }}</b></span>
        <span v-else><b>{{ rows.length }}</b> 个可执行 · 已选 <b>{{ selectedSummary }}</b></span>
        <button class="shanmao-toggle nodrag" type="button" :aria-expanded="expanded" @click.stop="toggleExpanded">{{ expanded ? "收起" : "查看" }}</button>
      </div>
      <div v-if="expanded" class="shanmao-list">
        <label v-for="(row, index) in rows" :key="row.id" class="shanmao-row nodrag" :class="{ 'shanmao-unchecked': !checked.has(row.id) }">
          <input type="checkbox" :checked="checked.has(row.id)" :disabled="running" :aria-label="row.label" @change="toggle(row.id, checkedInput($event))">
          <span class="shanmao-index">{{ index + 1 }}</span>
          <span class="shanmao-kind" :data-kind="row.kind">{{ captions[row.kind][0] }}</span>
          <span class="shanmao-name" :title="[row.label, layout.get(row.id) && `第 ${layout.get(row.id)} 层`, row.model, row.params].filter(Boolean).join('\n')">{{ row.label }}</span>
          <span class="shanmao-row-state" :data-state="jobs[row.id]?.state" :title="jobs[row.id]?.detail">{{ displayStatus(row) }}</span>
        </label>
        <div v-if="!rows.length" class="shanmao-empty">这张画布上没有可执行的节点</div>
      </div>
      <div class="shanmao-filters">
        <label v-for="kind in kinds" :key="kind" class="shanmao-chip nodrag">
          <input type="checkbox" :checked="!!groups[kind].length && groupCount(kind) === groups[kind].length"
            :indeterminate.prop="groupCount(kind) > 0 && groupCount(kind) < groups[kind].length" :disabled="running" @change="toggleGroup(kind)">
          <span>{{ captions[kind] }}</span>
        </label>
      </div>
      <div class="shanmao-notice">
        <label class="shanmao-chip nodrag">
          <input type="checkbox" :checked="!!groups.new.length && groupCount('new') === groups.new.length"
            :indeterminate.prop="groupCount('new') > 0 && groupCount('new') < groups.new.length" :disabled="running" @change="toggleGroup('new')">
          <span>未生成</span>
        </label>
        <strong>执行前请认真核对勾选清单</strong>
      </div>
      <div class="shanmao-quote">预计生成费用 <b :class="{ 'shanmao-amount': quoteLabel.startsWith('约 ') }">{{ quoteLabel }}</b></div>
      <div class="shanmao-progress" role="progressbar" :aria-valuenow="runIds.length ? Math.round(progress * 100 / runIds.length) : 0">
        <span :style="{ width: runIds.length ? `${progress * 100 / runIds.length}%` : '0%' }" />
      </div>
      <div class="shanmao-footer">
        <button class="shanmao-run nodrag" type="button" :disabled="running || !selected.length" @click.stop="startPanel">
          {{ running ? '执行中…' : selected.length ? `执行 ${selected.length} 个` : '先勾选节点' }}
        </button>
        <button v-if="running" class="shanmao-stop nodrag" type="button" @click.stop="stop">停止</button>
      </div>
      <div v-if="status" class="shanmao-status" :class="{ 'shanmao-error': failed }" aria-live="polite">{{ status }}</div>
    </div>
    <Teleport v-if="toolbar" :to="toolbar">
      <button type="button" class="el-button shanmao-selection-action" :disabled="running"
        @pointerdown.stop @mousedown.stop @click.stop="showCanvasSelection">批量生成</button>
    </Teleport>
    <Teleport to="body">
      <dialog ref="dialog" class="shanmao-dialog" aria-label="核对批量生成清单" @click.self="dialog?.close()">
        <div class="shanmao-dialog-body">
          <strong class="shanmao-warning">批量生成会消耗额度</strong>
          <p>请核对节点的模型、参数和已有结果，再执行。</p>
          <label v-if="dialogRows.length" class="shanmao-dialog-item">
            <input type="checkbox" :checked="dialogSelected.length === dialogRows.length"
              :indeterminate.prop="dialogSelected.length > 0 && dialogSelected.length < dialogRows.length" @change="toggleDialogAll(checkedInput($event))">
            全选（{{ dialogSelected.length }} / {{ dialogRows.length }}）
          </label>
          <div class="shanmao-dialog-list">
            <label v-for="row in dialogRows" :key="row.id" class="shanmao-dialog-item">
              <input type="checkbox" :checked="dialogChecks.has(row.id)" @change="toggleDialog(row.id, checkedInput($event))">
              <span>
                <span>{{ captions[row.kind] }} · {{ row.label }}</span>
                <small>{{ [row.model, row.params, row.hasResult ? '已有结果 · 执行将覆盖' : ''].filter(Boolean).join(' · ') }}</small>
              </span>
            </label>
            <div v-for="name in ignored" :key="name" class="shanmao-dialog-muted">{{ name }} · 无生成动作</div>
            <div v-if="!dialogRows.length && !ignored.length" class="shanmao-dialog-muted">请先框选画布节点</div>
          </div>
          <p v-if="missingUpstream" class="shanmao-warning">有 {{ missingUpstream }} 个节点的上游尚无结果且未勾选。</p>
          <label v-if="dialogSelected.length >= 15" class="shanmao-dialog-item shanmao-warning">
            <input v-model="dialogConfirmed" type="checkbox"> 本次节点较多，我已核对清单
          </label>
          <div class="shanmao-dialog-actions">
            <button type="button" class="shanmao-stop" @click="dialog?.close()">取消</button>
            <button type="button" class="shanmao-run" :disabled="!dialogSelected.length || (dialogSelected.length >= 15 && !dialogConfirmed)" @click="acceptDialog">
              {{ dialogSelected.length ? `开始执行 ${dialogSelected.length} 个` : '先勾选节点' }}
            </button>
          </div>
        </div>
      </dialog>
    </Teleport>
  </NodeSkeleton>
</template>

<style>
.nodeSkeleton.shanmao-batch-generate:not(.documentNode) { width: 210px; }
.shanmao-panel { display: flex; flex-direction: column; gap: 5px; padding: 2px; box-sizing: border-box; height: 100%; min-height: 0; font-size: 12px; color: var(--el-text-color-primary); }
.shanmao-panel button, .shanmao-dialog button { font: inherit; cursor: pointer; }
.shanmao-summary { display: flex; justify-content: space-between; gap: 4px; flex: none; font-size: 11px; color: var(--el-text-color-secondary); }
.shanmao-toggle { flex: none; padding: 0; border: 0; background: transparent; color: var(--el-color-success, #67c23a); }
.shanmao-list { max-height: 300px; min-height: 0; overflow: auto; padding: 3px 0; border-block: 1px solid var(--el-border-color-lighter); }
.shanmao-batch-generate.resized .shanmao-list { max-height: none; flex: 1 1 auto; }
.shanmao-row { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 2px 3px; font-size: 11px; line-height: 1.4; border-radius: 3px; }
.shanmao-row:hover { background: var(--el-fill-color-lighter); }
.shanmao-unchecked { opacity: .65; }
.shanmao-index { flex: 0 0 14px; text-align: right; color: var(--el-text-color-secondary); }
.shanmao-kind { display: inline-grid; place-items: center; flex: 0 0 14px; height: 14px; border-radius: 3px; background: #3984c4; color: white; font-size: 9px; }
.shanmao-kind[data-kind="video"] { background: #a8661f; }
.shanmao-kind[data-kind="audio"] { background: #547e2d; }
.shanmao-kind[data-kind="text"] { background: #7658ba; }
.shanmao-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shanmao-row-state { flex: none; max-width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--el-text-color-secondary); }
.shanmao-row-state[data-state="failed"], .shanmao-row-state[data-state="blocked"], .shanmao-error { color: var(--el-color-danger, #d74747); }
.shanmao-row-state[data-state="done"] { color: var(--el-color-success, #50923e); }
.shanmao-empty { padding: 12px 0; text-align: center; color: var(--el-text-color-secondary); font-size: 11px; }
.shanmao-filters { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 5px 12px; }
.shanmao-chip { flex: none; display: inline-flex; gap: 4px; align-items: center; font-size: 11px; cursor: pointer; white-space: nowrap; }
.shanmao-panel input[type="checkbox"] { flex: none; width: 12px; height: 12px; margin: 0; cursor: pointer; }
.shanmao-notice { flex: none; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.shanmao-notice strong { color: var(--el-color-warning, #e6a23c); font-size: 10px; }
.shanmao-quote { flex: none; display: flex; gap: 4px; align-items: baseline; font-size: 10px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.shanmao-quote b { font-size: 11px; }
.shanmao-quote .shanmao-amount { color: var(--el-color-danger, #f56c6c); }
.shanmao-progress { flex: none; height: 3px; overflow: hidden; background: var(--el-fill-color-dark, #e6e8eb); border-radius: 4px; }
.shanmao-progress span { display: block; height: 100%; background: var(--el-color-primary, #409eff); }
.shanmao-footer, .shanmao-dialog-actions { display: flex; gap: 6px; flex: none; }
.shanmao-run, .shanmao-stop { min-height: 25px; border-radius: 5px; padding: 2px 10px; }
.shanmao-run { flex: 1; color: white; background: var(--el-color-primary, #409eff); border: 0; }
.shanmao-run:disabled { opacity: .5; cursor: not-allowed; }
.shanmao-stop { background: var(--el-bg-color, white); color: var(--el-text-color-primary); border: 1px solid var(--el-border-color, #dcdfe6); }
.shanmao-status { flex: none; font-size: 10px; overflow-wrap: anywhere; }
.shanmao-dialog { width: min(450px, 84vw); padding: 16px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 10px; background: var(--el-bg-color, white); color: var(--el-text-color-primary, #252525); font-size: 12px; }
.shanmao-dialog::backdrop { background: #0006; }
.shanmao-warning { color: var(--el-color-warning, #ad7317); font-weight: 700; }
.shanmao-dialog p { margin: 6px 0 10px; }
.shanmao-dialog-list { max-height: min(270px, 42vh); overflow-y: auto; margin: 6px 0; border-block: 1px solid var(--el-border-color-lighter, #eee); }
.shanmao-dialog-item { display: flex; align-items: flex-start; gap: 6px; padding: 4px 0; overflow-wrap: anywhere; cursor: pointer; }
.shanmao-dialog-item input { margin: 2px 0 0; }
.shanmao-dialog-item small { display: block; color: var(--el-text-color-secondary, #777); }
.shanmao-dialog-muted { color: var(--el-text-color-secondary, #777); padding: 4px 0; overflow-wrap: anywhere; }
.shanmao-dialog-actions { justify-content: flex-end; margin-top: 8px; }
.shanmao-dialog-actions .shanmao-run { flex: none; }
</style>
