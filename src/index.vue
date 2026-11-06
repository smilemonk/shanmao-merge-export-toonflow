<template>
  <nodeSkeleton v-bind="nodeProps">
    <div class="mergeExport" :class="{ resized }">
      <!-- 头部统计 + 全选 -->
      <div class="headRow">
        <span class="headMain">
          <b>{{ readyList.length }}</b> 个视频 · 已选 <b>{{ checkedIds.length }}</b> 个
        </span>
        <label class="opt">
          <input type="checkbox" :checked="allReadyChecked" @change="toggleAll" />
          <span>全选</span>
        </label>
      </div>
      <div class="hintLine">按名称顺序合并</div>

      <!-- 视频清单 -->
      <div class="list" :style="listMaxStyle">
        <div v-if="!videoNodes.length" class="empty">这张画布上没有带视频输出的节点</div>
        <div
          v-for="(item, idx) in videoNodes"
          :key="item.id"
          class="row"
          :class="{ off: !item.url }"
        >
          <input
            class="ck"
            type="checkbox"
            :disabled="!item.url"
            :checked="checkedSet.has(item.id)"
            @change="toggle(item.id)"
          />
          <span class="idx">{{ idx + 1 }}</span>
          <span class="nm" :title="item.title">{{ item.label }}</span>
          <span class="st" :class="{ ok: item.url }">{{ item.url ? formatDur(item.duration) : "未生成" }}</span>
        </div>
      </div>

      <!-- 进度条 -->
      <div v-if="phase === 'merging' || phase === 'probing'" class="bar">
        <i :style="{ width: `${progress}%` }"></i>
      </div>

      <!-- 操作区 -->
      <div class="footRow">
        <button
          class="runBtn"
          type="button"
          :disabled="busy || checkedReady.length < 2"
          @click="runMerge(checkedReady.map(v => v.id))"
        >
          {{ phase === "probing" ? "预检中…" : phase === "merging" ? "合并中…" : checkedReady.length < 2 ? `勾选至少 2 个（当前 ${checkedReady.length}）` : `合并导出 ${checkedReady.length} 个` }}
        </button>
        <button v-if="busy" class="stopBtn" type="button" @click="stopRun">停止</button>
      </div>

      <!-- 状态 -->
      <div v-if="statusMsg" class="status" :class="{ err: phase === 'error' }">{{ statusMsg }}</div>

      <!-- 参数不一致时的基准档选择 -->
      <div v-if="transcodeGroups.length && transcodeOffer && !busy" class="tcGroups">
        <button
          v-for="g in transcodeGroups"
          :key="g.key"
          class="tcBtn"
          type="button"
          @click="applyAlignment(g.key)"
        >
          以 {{ g.short }} 为准 —— {{ g.count }} 段原样，{{ transcodeGroups.reduce((s, x) => s + x.count, 0) - g.count }} 段转码
        </button>
      </div>

      <!-- 结果预览 -->
      <video v-if="previewUrl && phase !== 'merging'" class="preview" controls :src="previewUrl"></video>
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { nodeSkeleton, useNode, z } from "@toonflow/nodes-scaffold/runtime";
import { useNodePersistence } from "@toonflow/nodes-scaffold/nodeDocument";
import type { BrowserFfmpegFactory } from "@toonflow/nodes-scaffold/nodeFfmpeg";
import type { Node as FlowNode } from "@vue-flow/core";
import { alignmentOptions, canvasFileName, concatList, inspectMedia, supportsAlignmentGeometry, workspacePath } from "./media";

defineOptions({
  inheritAttrs: false,
  handles: [{ id: "video", type: "source", dataType: "VIDEO", label: "合并成片" }],
});

const { id: selfId, node, nodeProps, outputs, nodeTools, nodeEvent, files, ffmpeg: loadFfmpeg } = useNode({
  label: "合并导出视频",
  outputs: { video: { dataType: "VIDEO", value: undefined } },
});

const flow = useVueFlow();
const getPersistence = useNodePersistence();
const durations = shallowRef(new Map<string, number>());
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });

/* ---------------- 画布视频节点扫描 ---------------- */

interface VideoItem {
  id: string;
  label: string;
  url: string | null;
  mimeType: string;
  title: string;
  duration: number | null;
}

function findVideoOutput(node: FlowNode): { url: string; mimeType: string } | null {
  const outs = (node.data as Record<string, unknown> | undefined)?.outputs;
  if (!outs || typeof outs !== "object") return null;
  for (const v of Object.values(outs as Record<string, unknown>)) {
    const o = v as { dataType?: string; value?: { url?: string; mimeType?: string } } | null;
    if (o && o.dataType === "VIDEO" && o.value?.url) {
      return { url: String(o.value.url), mimeType: String(o.value.mimeType ?? "video/mp4") };
    }
  }
  return null;
}

/** 端口声明里有 VIDEO 输出的才算视频节点（未生成也列出，图片/文本/音频不进清单） */
function hasVideoPort(flowNode: FlowNode): boolean {
  const handles = (flowNode.data as Record<string, unknown> | undefined)?.handles;
  if (!Array.isArray(handles)) return false;
  return handles.some(h => {
    const hh = h as { type?: string; dataType?: string | string[] };
    if (hh.type !== "source") return false;
    const dt = hh.dataType;
    return Array.isArray(dt) ? dt.includes("VIDEO") : dt?.split(",").some(value => value.trim() === "VIDEO");
  });
}

const videoNodes = computed<VideoItem[]>(() => {
  const list: VideoItem[] = [];
  for (const n of flow.getNodes.value ?? []) {
    if (n.id === selfId) continue;
    // 排除其它无损合并节点（避免把上一次合并结果再次并进来）
    if (/mergeexport/i.test(String(n.type ?? ""))) continue;
    if (!hasVideoPort(n)) continue;
    const out = findVideoOutput(n);
    const label = String((n.data as Record<string, unknown> | undefined)?.label ?? n.label ?? n.id);
    list.push({
      id: String(n.id),
      label,
      url: out?.url ?? null,
      mimeType: out?.mimeType ?? "video/mp4",
      title: out?.url ?? "尚未生成输出",
      duration: out ? durations.value.get(out.url) ?? null : null,
    });
  }
  return list.sort((a, b) => collator.compare(a.label, b.label) || a.id.localeCompare(b.id));
});

const readyList = computed(() => videoNodes.value.filter(v => v.url));
const checkedSet = ref<Set<string>>(new Set());
// 默认勾选全部已生成的视频节点；新生成/新出现的节点自动补勾
const knownIds = new Set<string>();
function syncDefaultChecks() {
  const existing = new Set(videoNodes.value.map(item => item.id));
  const next = new Set([...checkedSet.value].filter(id => existing.has(id)));
  for (const id of knownIds) if (!existing.has(id)) knownIds.delete(id);
  for (const item of readyList.value) {
    if (knownIds.has(item.id)) continue;
    knownIds.add(item.id);
    next.add(item.id);
  }
  checkedSet.value = next;
}
syncDefaultChecks();
watch(() => videoNodes.value.map(item => [item.id, Boolean(item.url)]), syncDefaultChecks);

const checkedIds = computed(() => readyList.value.filter(v => checkedSet.value.has(v.id)).map(v => v.id));
const checkedReady = computed(() => readyList.value.filter(v => checkedSet.value.has(v.id)));
const allReadyChecked = computed(() => readyList.value.length > 0 && readyList.value.every(v => checkedSet.value.has(v.id)));

/* ---------------- 尺寸自适应 ---------------- */

// 用户拖拽调整过节点高度后（node.style.height 有值），清单改为撑满剩余空间
const resized = computed(() => {
  const style = (node as unknown as { style?: unknown })?.style;
  const s = typeof style === "function" ? undefined : style;
  return Boolean(s && typeof s === "object" && (s as { height?: unknown }).height);
});

// 未手动调整时：初始高度随条目数适度增长（至少 10 行全部可见），封顶 ~20 条后滚动
const listMaxStyle = computed(() => {
  if (resized.value) return undefined;
  const rows = Math.min(Math.max(videoNodes.value.length, 10), 20);
  return { maxHeight: `${rows * 24 + 8}px` };
});

function toggle(id: string) {
  clearOffer();
  const next = new Set(checkedSet.value);
  next.has(id) ? next.delete(id) : next.add(id);
  checkedSet.value = next;
}
function toggleAll() {
  clearOffer();
  const readyIds = new Set(readyList.value.map(v => v.id));
  const next = new Set(checkedSet.value);
  if (allReadyChecked.value) {
    for (const id of readyIds) next.delete(id);
  } else {
    for (const id of readyIds) next.add(id);
  }
  checkedSet.value = next;
}

/* ---------------- 合并执行 ---------------- */

type Phase = "idle" | "probing" | "merging" | "done" | "error";
const phase = ref<Phase>("idle");
const progress = ref(0);
const statusMsg = ref("");
const transcodeOffer = shallowRef<{ ids: string[]; urls: string[] }>();
const transcodeGroups = ref<{ key: string; short: string; count: number }[]>([]);
const abortRef = shallowRef<AbortController>();
const busy = computed(() => Boolean(abortRef.value));

function setStatus(message: string, next: Phase) {
  statusMsg.value = message;
  phase.value = next;
}

function formatDur(seconds: number | null) {
  return seconds == null ? "" : `${seconds.toFixed(1)}s`;
}

function stamp() {
  const now = new Date();
  const parts = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, "0"));
  return `${parts.slice(0, 3).join("")}_${parts.slice(3).join("")}`;
}

function clearOffer() {
  if (!transcodeOffer.value) return;
  transcodeOffer.value = undefined;
  transcodeGroups.value = [];
  setStatus("", "idle");
}

function applyAlignment(key: string) {
  const offer = transcodeOffer.value;
  if (offer) void runMerge(offer.ids, { baseKey: key, expectedUrls: offer.urls });
}

async function probe(ffmpeg: BrowserFfmpegFactory, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const data = await new Promise<Parameters<typeof inspectMedia>[0]>((resolve, reject) => {
    ffmpeg.ffprobe(path, (error, result) => error ? reject(error) : resolve(result));
  });
  signal.throwIfAborted();
  return inspectMedia(data);
}

async function runMerge(nodeIds: string[], options: { baseKey?: string; expectedUrls?: string[]; autoMajority?: boolean; signal?: AbortSignal } = {}) {
  if (busy.value) return { error: "正在执行中" };
  clearOffer();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  abortRef.value = controller;
  progress.value = 0;
  let workspace: ReturnType<typeof files.getWorkspaceFiles> | undefined;
  let stage: string | undefined;
  let archive: string | undefined;
  let published = false;
  try {
    signal.throwIfAborted();
    if (nodeIds.length < 2 || new Set(nodeIds).size !== nodeIds.length) throw new Error("请选择至少 2 个不同的已生成视频节点");
    const byId = new Map(videoNodes.value.map(item => [item.id, item]));
    const picked = nodeIds.map((id, i) => {
      const item = byId.get(id);
      if (!item?.url) throw new Error(`节点 ${item?.label ?? id} 没有可用的视频`);
      if (options.expectedUrls && item.url !== options.expectedUrls[i]) throw new Error("选择基准档后源素材已变化，请重新预检");
      return { ...item, path: workspacePath(item.url) };
    });

    const name = canvasFileName(getPersistence?.()?.canvasPath ?? "");
    setStatus("预检编码参数…", "probing");
    workspace = files.getWorkspaceFiles();
    const ffmpeg = await loadFfmpeg(signal);
    const metadata = new Map<string, Awaited<ReturnType<typeof probe>>>();
    const groups = new Map<string, { key: string; short: string; count: number }>();
    const parts = [];
    for (const item of picked) {
      let profile;
      try {
        profile = metadata.get(item.path) ?? await probe(ffmpeg, item.path, signal);
      } catch (error) {
        throw new Error(`${item.label}：${error instanceof Error ? error.message : String(error)}`);
      }
      metadata.set(item.path, profile);
      const group = groups.get(profile.key) ?? { key: profile.key, short: profile.short, count: 0 };
      group.count++;
      groups.set(profile.key, group);
      parts.push({ item, profile, path: item.path });
      progress.value = Math.round(parts.length / picked.length * 100);
    }
    durations.value = new Map(parts.map(({ item, profile }) => [item.url!, profile.duration]));
    const profiles = [...groups.values()].sort((a, b) => b.count - a.count);
    if (profiles.length > 1 && !options.baseKey && !options.autoMajority) {
      const lines = parts.map(({ item, profile }) => `${item.label}：${profile.short}`).join("\n");
      transcodeOffer.value = { ids: nodeIds.slice(), urls: picked.map(item => item.url!) };
      transcodeGroups.value = profiles;
      setStatus(`编码参数不一致，请选择基准档。\n${lines}`, "error");
      return { error: "编码参数不一致", groups: profiles, details: lines };
    }

    const baseKey = options.baseKey ?? profiles[0].key;
    const base = parts.find(part => part.profile.key === baseKey)?.profile;
    if (!base) throw new Error("基准档已变化，请重新预检");
    const different = parts.filter(part => part.profile.key !== baseKey);
    if (different.some(part => Boolean(part.profile.audio) !== Boolean(base.audio))) {
      throw new Error("有声与无声片段无法自动对齐，请选择音轨配置一致的片段");
    }
    if (different.some(part => !supportsAlignmentGeometry(part.profile))) {
      throw new Error("带旋转标记、非方形像素或 HDR 的异档片段暂不支持自动对齐");
    }
    const encoding = different.length ? alignmentOptions(base) : [];

    const root = "合并导出视频";
    const input = `${root}/input/${name}`;
    const exportId = `${name}_${stamp()}_${crypto.randomUUID().slice(0, 8)}`;
    const output = `${root}/${exportId}.mp4`;
    const pendingArchive = `${input}/${exportId}.txt`;
    for (const dir of [root, `${root}/input`, input]) {
      signal.throwIfAborted();
      await workspace.mkdir(dir).catch((error: { code?: string; response?: { data?: { data?: { code?: string } } } }) => {
        if (error.code !== "EEXIST" && error.response?.data?.data?.code !== "EEXIST") throw error;
      });
    }
    signal.throwIfAborted();
    const stageDir = `${input}/.merge-${exportId.slice(-8)}`;
    await workspace.mkdir(stageDir);
    stage = stageDir;

    for (const [index, part] of different.entries()) {
      signal.throwIfAborted();
      setStatus(`转码对齐中 ${index + 1}/${different.length}：${part.item.label}`, "merging");
      const target = `${stage}/part-${index + 1}.mp4`;
      await new Promise<void>((resolve, reject) => {
        ffmpeg(part.path).outputOptions(encoding).on("error", reject).on("end", () => resolve()).save(target);
      });
      const aligned = await probe(ffmpeg, target, signal);
      if (aligned.key !== baseKey) throw new Error(`${part.item.label} 转码后仍未达到基准参数，未生成成片`);
      part.path = target;
      progress.value = Math.round((index + 1) / different.length * 40);
    }

    const playlist = `${stage}/concat.txt`;
    const partial = `${stage}/output.mp4`;
    const total = parts.reduce((sum, part) => sum + part.profile.duration, 0);
    const progressStart = different.length ? 40 : 0;
    signal.throwIfAborted();
    await workspace.write(playlist, concatList(parts.map(part => part.path), 4), true);
    signal.throwIfAborted();
    setStatus("合并中…（流拷贝）", "merging");
    progress.value = progressStart;
    await new Promise<void>((resolve, reject) => {
      ffmpeg(playlist).inputOptions(["-f concat", "-safe 0", "-protocol_whitelist file"])
        .outputOptions(["-map 0:v:0", "-map 0:a:0?", "-c copy"])
        .on("progress", info => {
          const seconds = info.timemark.split(":").reduce((value, part) => value * 60 + Number(part), 0);
          if (Number.isFinite(seconds)) progress.value = Math.max(progress.value,
            Math.min(99, Math.round(progressStart + (100 - progressStart) * seconds / total)));
        })
        .on("error", reject).on("end", () => resolve()).save(partial);
    });

    const result = await probe(ffmpeg, partial, signal);
    const durationTolerance = Math.max(0.2, parts.length * 0.08);
    if (Math.abs(result.duration - total) > durationTolerance || Boolean(result.audio) !== Boolean(base.audio)
        || result.video.width !== base.video.width || result.video.height !== base.video.height || result.video.codec_name !== base.video.codec_name) {
      throw new Error("合并结果的轨道、尺寸或时长异常，未发布成片");
    }
    signal.throwIfAborted();
    await workspace.write(pendingArchive, concatList(picked.map(item => item.path), 3), true);
    archive = pendingArchive;
    signal.throwIfAborted();
    await workspace.rename(partial, output);
    published = true;
    outputs.value.video = { dataType: "VIDEO", value: { url: output, mimeType: "video/mp4" } };
    setStatus(`完成：${output} · ${formatDur(result.duration)}（${different.length ? `${different.length} 段已转码，其余原样` : "零转码"}）`, "done");
    progress.value = 100;
    return { output, total: result.duration, segments: parts.map(part => ({ nodeId: part.item.id, duration: part.profile.duration })) };
  } catch (error) {
    const message = signal.aborted ? "已停止" : error instanceof Error ? error.message : String(error);
    setStatus(signal.aborted ? message : `合并失败：${message}`, "error");
    return { error: message };
  } finally {
    if (archive && !published) await workspace?.remove(archive).catch(() => {});
    if (stage) await workspace?.remove(stage, true).catch(() => {});
    abortRef.value = undefined;
  }
}

function stopRun() {
  if (!abortRef.value || abortRef.value.signal.aborted) return;
  statusMsg.value = "正在停止…";
  abortRef.value.abort(new Error("已停止"));
}

onScopeDispose(stopRun);
nodeEvent.on("save", reason => {
  if (reason === "reload" && busy.value) throw new Error("导出正在进行，请先停止或等待完成");
});
nodeEvent.on("delete", () => {
  if (busy.value) throw new Error("导出正在进行，请先停止或等待完成");
});

/* ---------------- 预览 ---------------- */

const previewUrl = files.useFileUrl(computed(() => outputs.value.video?.value), () => {});

/* ---------------- MCP / Agent 函数 ---------------- */

nodeTools.register({
  name: "listVideoNodes",
  description: "列出画布上有视频输出的节点（含已生成素材路径与时长），按名称排序。未生成的也会列出并标注",
  parameters: z.strictObject({}),
  execute() {
    return {
      total: videoNodes.value.length,
      ready: readyList.value.length,
      nodes: videoNodes.value.map(v => ({
        nodeId: v.id, label: v.label, hasOutput: Boolean(v.url), path: v.url ?? null, duration: v.duration,
      })),
    };
  },
});

nodeTools.register({
  name: "mergeExport",
  description: "把视频节点当前输出的素材合并导出到「合并导出视频」目录，成片文件名 = 画布名 + 日期时间，每次导出为新文件不覆盖旧片。各段编码参数一致时流拷贝拼接；allowTranscode 为 true 且参数不一致时，自动以多数档为基准，把少数档转码对齐后合并。nodeIds 按传入顺序合并；不传则取当前勾选的节点，按名称序合并",
  parameters: z.strictObject({
    nodeIds: z.array(z.string().min(1)).min(2).optional().describe("参与合并的视频节点 ID，按数组顺序合并"),
    allowTranscode: z.boolean().optional().describe("参数不一致时是否自动以多数档为基准转码对齐（默认 false，即不一致时返回各参数档信息并报错）"),
  }),
  async execute({ nodeIds, allowTranscode }, { signal }) {
    const ids = nodeIds ?? checkedIds.value;
    return runMerge(ids, { autoMajority: Boolean(allowTranscode), signal });
  },
});
</script>

<style scoped>
.mergeExport { display: flex; flex-direction: column; gap: 6px; font-size: 12px; height: 100%; min-height: 0; box-sizing: border-box; }
.headRow { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--el-text-color-secondary); flex: none; }
.headMain b { font-size: 13px; color: var(--el-text-color-primary); }
.hintLine { font-size: 11px; color: #c0392b; font-weight: 600; flex: none; text-align: left; }
.opt { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.opt input { width: 13px; height: 13px; margin: 0; cursor: pointer; }
.list { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; padding: 3px 0; border-top: 1px solid var(--el-border-color-lighter); border-bottom: 1px solid var(--el-border-color-lighter); min-height: 0; }
.mergeExport.resized .list { flex: 1 1 auto; }
.empty { padding: 12px 0; text-align: center; font-size: 12px; color: var(--el-text-color-placeholder); }
.row { display: flex; align-items: center; gap: 5px; padding: 2px 3px; border-radius: 3px; font-size: 12px; line-height: 1.5; }
.row:hover { background: var(--el-fill-color-lighter); }
.row.off { opacity: 0.55; }
.ck { flex: none; width: 13px; height: 13px; margin: 0; cursor: pointer; }
.idx { width: 18px; flex: none; text-align: right; font-size: 11px; color: var(--el-text-color-placeholder); }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-regular); }
.st { flex: none; font-size: 11px; color: var(--el-text-color-placeholder); max-width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st.ok { color: var(--el-text-color-secondary); }
.bar { height: 3px; flex: none; border-radius: 2px; background: var(--el-fill-color-dark); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 2px; background: var(--el-color-primary, #409eff); transition: width 0.25s ease; }
.footRow { display: flex; gap: 6px; flex: none; }
.tcGroups { display: flex; flex-direction: column; gap: 4px; flex: none; }
.tcBtn { width: 100%; min-height: 24px; border: 1px solid var(--el-color-primary); border-radius: 5px; background: var(--el-bg-color); color: var(--el-color-primary); font-size: 11px; line-height: 1.4; cursor: pointer; padding: 3px 6px; }
.tcBtn:hover { background: var(--el-color-primary); color: #fff; }
.runBtn { flex: 1; height: 26px; border: 0; border-radius: 5px; background: var(--el-color-primary, #409eff); color: #fff; font-size: 12px; cursor: pointer; }
.runBtn:disabled { opacity: 0.5; cursor: not-allowed; }
.stopBtn { width: 54px; height: 26px; border: 1px solid var(--el-border-color); border-radius: 5px; background: var(--el-bg-color); color: var(--el-text-color-regular); font-size: 12px; cursor: pointer; }
.stopBtn:hover { color: #c0392b; border-color: #c0392b; }
.status { font-size: 11px; line-height: 1.5; color: var(--el-text-color-secondary); word-break: break-all; white-space: pre-wrap; flex: none; }
.status.err { color: #c0392b; }
.preview { width: 100%; max-height: 140px; border-radius: 4px; background: #000; flex: none; }
</style>
