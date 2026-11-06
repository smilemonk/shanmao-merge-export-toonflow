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
          @click="runMerge(transcodeOffer!, { baseKey: g.key })"
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
import { computed, ref, shallowRef, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { nodeSkeleton, useNode, z } from "@toonflow/nodes-scaffold/runtime";
import type { Node as FlowNode } from "@vue-flow/core";

defineOptions({
  inheritAttrs: false,
  handles: [{ id: "video", type: "source", dataType: "VIDEO", label: "合并成片" }],
});

const { id: selfId, node, nodeProps, outputs, nodeTools, files, ffmpeg: loadFfmpeg } = useNode({
  label: "合并导出视频",
  outputs: { video: { dataType: "VIDEO", value: undefined } },
});

const flow = useVueFlow();

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
    return dt === "VIDEO" || (Array.isArray(dt) && dt.includes("VIDEO"));
  });
}

const videoNodes = computed<VideoItem[]>(() => {
  const list: VideoItem[] = [];
  for (const n of flow.getNodes.value ?? []) {
    if (n.id === selfId) continue;
    // 排除其它无损合并节点（避免把上一次合并结果再次并进来）
    if (String(n.type ?? "").includes("mergeExport")) continue;
    if (!hasVideoPort(n)) continue;
    const out = findVideoOutput(n);
    const label = String((n.data as Record<string, unknown> | undefined)?.label ?? n.label ?? n.id);
    list.push({
      id: String(n.id),
      label,
      url: out?.url ?? null,
      mimeType: out?.mimeType ?? "video/mp4",
      title: out?.url ?? "尚未生成输出",
      duration: null,
    });
  }
  return list.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN", { numeric: true }));
});

const readyList = computed(() => videoNodes.value.filter(v => v.url));
const checkedSet = ref<Set<string>>(new Set());
// 默认勾选全部已生成的视频节点；新生成/新出现的节点自动补勾
const knownIds = new Set<string>();
function syncDefaultChecks() {
  for (const item of readyList.value) {
    if (!knownIds.has(item.id)) {
      knownIds.add(item.id);
      checkedSet.value = new Set(checkedSet.value).add(item.id);
    }
  }
}
syncDefaultChecks();
watch(videoNodes, syncDefaultChecks);

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
  const next = new Set(checkedSet.value);
  next.has(id) ? next.delete(id) : next.add(id);
  checkedSet.value = next;
}
function toggleAll() {
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
const resultPath = ref<string | null>(null);
const transcodeOffer = ref<string[] | null>(null);
const transcodeGroups = ref<{ key: string; short: string; count: number }[]>([]);

const abortRef = shallowRef<AbortController | null>(null);
let killCommand: { kill: () => void } | null = null;
const busy = computed(() => phase.value === "probing" || phase.value === "merging");

function setStatus(msg: string, p: Phase) {
  statusMsg.value = msg;
  phase.value = p;
}

function formatDur(sec: number | null): string {
  return sec == null || !Number.isFinite(sec) ? "" : `${Math.round(sec)}s`;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** concat 清单里的路径：单引号转义 */
function concatLine(path: string): string {
  return `file '${path.replace(/'/g, "'\\''")}'`;
}

/** 文件名安全化 */
function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 120) || "合并导出";
}

/** 画布名：优先取画布节点生成任务里记录的画布文件名；再查全局媒体任务注册表；画布永远有名字，兜底"画布" */
const canvasName = computed(() => {
  for (const n of flow.getNodes.value ?? []) {
    const cp = (n.data as { mediaTask?: { canvasPath?: unknown } } | undefined)?.mediaTask?.canvasPath;
    if (typeof cp === "string" && cp.trim()) return cp.trim().replace(/\.json$/i, "");
  }
  try {
    const reg = (globalThis as Record<symbol, unknown>)[Symbol.for("toonflow.nodeMediaTasks")] as
      | Map<string, { canvasPath?: unknown }>
      | undefined;
    if (reg instanceof Map) {
      for (const t of reg.values()) {
        const cp = t?.canvasPath;
        if (typeof cp === "string" && cp.trim()) return cp.trim().replace(/\.json$/i, "");
      }
    }
  } catch { /* 注册表不可用 */ }
  return "画布";
});

/** ffprobe 预检：读编码参数与时长 */
interface ProbeResult {
  duration: number;
  vcodec: string; w: number; h: number;
  acodec: string; sr: number;
  hasAudio: boolean;
  key: string; profileText: string; paramShort: string;
}
async function probe(ffmpegFactory: unknown, path: string, label: string): Promise<ProbeResult> {
  const none: ProbeResult = { duration: 0, vcodec: "", w: 0, h: 0, acodec: "", sr: 0, hasAudio: false, key: "", profileText: "" };
  const ff = ffmpegFactory as { ffprobe?: (p: string, cb: (err: Error | null, data?: unknown) => void) => void };
  if (typeof ff.ffprobe !== "function") return none;
  const data = await new Promise<Record<string, any>>((resolve, reject) => {
    ff.ffprobe!(path, (err, d) => (err ? reject(err) : resolve(d as Record<string, any>)));
  });
  const v = (data.streams ?? []).find((s: Record<string, any>) => s.codec_type === "video");
  const a = (data.streams ?? []).find((s: Record<string, any>) => s.codec_type === "audio");
  const r: ProbeResult = {
    duration: Number(data.format?.duration ?? v?.duration ?? 0) || 0,
    vcodec: v ? String(v.codec_name ?? "") : "",
    w: v ? Number(v.width ?? 0) : 0,
    h: v ? Number(v.height ?? 0) : 0,
    acodec: a ? String(a.codec_name ?? "") : "",
    sr: a ? Number(a.sample_rate ?? 0) : 0,
    hasAudio: Boolean(a),
    key: "",
    profileText: "",
  };
  r.key = `${r.vcodec}|${r.w}x${r.h}|${r.acodec}|${r.sr}`;
  r.profileText = `${label}：${r.vcodec || "无视频轨"} ${r.w}x${r.h}${r.hasAudio ? ` | ${r.acodec} ${r.sr}Hz` : " | 无音频轨"}`;
  r.paramShort = `${r.w}x${r.h}（${r.vcodec}${r.hasAudio ? ` · ${r.acodec} ${r.sr}Hz` : " · 无音频"}）`;
  return r;
}

/** 把一段视频转码对齐到基准参数（保比例缩放+黑边填充+音频重采样），产物写入 transcoded 目录 */
async function transcodeTo(
  ffmpeg: any, src: string, dst: string,
  target: { w: number; h: number; sr: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(src)
      .outputOptions([
        "-vf", `scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2`,
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", String(target.sr || 44100), "-ac", "2",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(dst);
    killCommand = cmd as { kill: () => void };
  });
}

async function runMerge(nodeIds: string[], opts: { baseKey?: string; autoMajority?: boolean } = {}): Promise<{ output?: string; total?: number; error?: string }> {
  if (busy.value) return { error: "正在执行中" };
  const picked = videoNodes.value.filter(v => nodeIds.includes(v.id) && v.url);
  if (picked.length < 2) {
    setStatus("至少勾选 2 个已生成的视频节点", "error");
    return { error: "至少需要 2 个已生成的视频节点" };
  }

  const controller = new AbortController();
  abortRef.value = controller;
  killCommand = null;
  progress.value = 0;
  resultPath.value = null;
  transcodeOffer.value = null;
  transcodeGroups.value = [];

  try {
    setStatus("预检编码参数…", "probing");
    const ffmpeg = await loadFfmpeg(controller.signal);
    const workspaceFiles = files.getWorkspaceFiles();

    // 1) 预检：逐段读取编码参数（ffprobe 不可用时跳过分流，直接合并）
    const probed: { item: VideoItem; result: ProbeResult }[] = [];
    for (let i = 0; i < picked.length; i++) {
      const r = await probe(ffmpeg, picked[i].url!, picked[i].label);
      probed.push({ item: picked[i], result: r });
      progress.value = Math.round(((i + 1) / picked.length) * 100);
    }
    const total = probed.reduce((s, p) => s + p.result.duration, 0);

    // 2) 一致性分流：一致直接拼；不一致时按参数档分组，等用户选择基准档（或 autoMajority 自动取多数档）
    const keyOf = (p: { result: ProbeResult }) => p.result.key;
    const uniqueKeys = [...new Set(probed.map(keyOf))];
    if (uniqueKeys.length > 1 && !opts.baseKey && !opts.autoMajority) {
      const groups = new Map<string, { key: string; short: string; count: number }>();
      for (const p of probed) {
        const g = groups.get(p.result.key) ?? { key: p.result.key, short: p.result.paramShort, count: 0 };
        g.count += 1;
        groups.set(p.result.key, g);
      }
      transcodeOffer.value = nodeIds;
      transcodeGroups.value = [...groups.values()].sort((a, b) => b.count - a.count);
      const lines = probed.map(p => p.result.profileText).join("\n");
      setStatus(`编码参数不一致，请选择以哪一档为准（其余段将转码对齐）：\n${lines}`, "error");
      return { error: `编码参数不一致：\n${lines}` };
    }
    const baseKey = opts.baseKey ?? (opts.autoMajority
      ? uniqueKeys.map(k => ({ k, n: probed.filter(p => keyOf(p) === k).length })).sort((a, b) => b.n - a.n)[0].k
      : uniqueKeys[0]);
    const base = probed.find(p => p.result.key === baseKey)!.result;
    const mismatched = probed.filter(p => p.result.key !== baseKey);
    if (mismatched.length > 0 && mismatched.some(p => p.result.hasAudio !== base.hasAudio)) {
      setStatus("有音频轨与无音频轨的段无法自动对齐，请取消勾选缺音频的段，或为它补上音频", "error");
      return { error: "音频轨有无不一致，无法自动对齐" };
    }

    // 3) 目录结构：合并导出视频/<画布名>_<时间>.mp4 + input/<画布名>/<画布名>_<同一时间>.txt
    const rootDir = "合并导出视频";
    const base2 = sanitizeName(canvasName.value);
    const inputDir = `${rootDir}/input/${base2}`;
    for (const dir of [rootDir, `${rootDir}/input`, inputDir]) {
      await workspaceFiles.mkdir(dir).catch(() => { /* 已存在 */ });
    }
    const runStamp = stamp();
    // 清单在三层子目录下，ffmpeg 按清单所在目录解析相对路径 → 前缀回根
    const prefix = "../".repeat(3);
    const listFile = `${inputDir}/${base2}_${runStamp}.txt`;
    const parts: { item: VideoItem; url: string }[] = probed.map(p => ({ item: p.item, url: p.item.url! }));

    // 3.5) 转码不一致段（保比例缩放对齐基准分辨率、音频重采样），产物存 transcoded/ 目录
    if (mismatched.length > 0) {
      const tcDir = `${inputDir}/transcoded`;
      await workspaceFiles.mkdir(tcDir).catch(() => { /* 已存在 */ });
      let done = 0;
      for (const p of mismatched) {
        const srcName = p.item.url!.split("/").pop() ?? `${p.item.id}.mp4`;
        const dst = `${tcDir}/${srcName.replace(/\.mp4$/i, "")}_${stamp()}.mp4`;
        setStatus(`转码对齐中 ${done + 1}/${mismatched.length}：${p.item.label}`, "merging");
        await transcodeTo(ffmpeg, p.item.url!, dst, { w: base.w, h: base.h, sr: base.sr });
        const hit = parts.find(x => x.item.id === p.item.id);
        if (hit) hit.url = dst;
        done += 1;
        progress.value = Math.round((done / mismatched.length) * 40);
      }
    }

    await workspaceFiles.write(listFile, parts.map(p => concatLine(prefix + p.url)).join("\n") + "\n");

    // 4) concat demuxer + 流拷贝合并（成片与清单共用同一时间戳，文件名一一对应）
    const output = `${rootDir}/${base2}_${runStamp}.mp4`;

    setStatus("合并中…（流拷贝，不重编码）", "merging");
    progress.value = 0;
    await new Promise<void>((resolve, reject) => {
      const cmd = (ffmpeg as any)(listFile)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .videoCodec("copy")
        .audioCodec("copy")
        .on("progress", (p: { timemark?: string }) => {
          // 按时间进度折算百分比；读不到总时长时只显示推进中
          const m = /(\d+):(\d+):(\d+)/.exec(p.timemark ?? "");
          if (m && total > 0) {
            const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
            progress.value = Math.min(99, Math.round((sec / total) * 100));
          } else {
            progress.value = Math.max(progress.value, 1);
          }
        })
        .on("error", reject)
        .on("end", () => resolve())
        .save(output);
      killCommand = cmd as { kill: () => void };
    });

    // 5) 回填输出（清单保留在 input 子目录，便于追溯本次合并了哪些素材）
    outputs.value.video = { dataType: "VIDEO", value: { url: output, mimeType: "video/mp4" } };
    resultPath.value = output;
    const totalText = total > 0 ? ` · 总时长约 ${Math.round(total)}s` : "";
    setStatus(mismatched.length > 0
      ? `完成：${output}${totalText}（${mismatched.length} 段已转码对齐，其余原样）`
      : `完成：${output}${totalText}（零转码）`, "done");
    progress.value = 100;
    return { output, total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`合并失败：${msg}`, "error");
    return { error: msg };
  } finally {
    abortRef.value = null;
    killCommand = null;
  }
}

function stopRun() {
  if (!busy.value) return;
  try { killCommand?.kill(); } catch { /* ignore */ }
  abortRef.value?.abort();
  setStatus("已停止", "error");
}

/* ---------------- 预览 ---------------- */

const previewUrl = files.useFileUrl(
  computed(() => (outputs.value.video?.value as { url?: string; mimeType?: string } | undefined) ?? undefined),
  () => {},
);

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
        nodeId: v.id, label: v.label, hasOutput: Boolean(v.url), path: v.url ?? null,
      })),
    };
  },
});

nodeTools.register({
  name: "mergeExport",
  description: "把视频节点当前输出的素材合并导出到「合并导出视频」目录，成片文件名 = 画布名 + 日期时间，每次导出为新文件不覆盖旧片。各段编码参数一致时流拷贝拼接（画面声音与源文件完全一致）；allowTranscode 为 true 且参数不一致时，自动以多数档为基准，把少数档转码对齐后合并。nodeIds 按传入顺序合并；不传则取全部已生成视频节点按名称序合并",
  parameters: z.strictObject({
    nodeIds: z.array(z.string().min(1)).optional().describe("参与合并的视频节点 ID，按数组顺序合并"),
    allowTranscode: z.boolean().optional().describe("参数不一致时是否自动以多数档为基准转码对齐（默认 false，即不一致时返回各参数档信息并报错）"),
  }),
  async execute({ nodeIds, allowTranscode }, { signal }) {
    if (signal) {
      signal.addEventListener("abort", () => stopRun(), { once: true });
    }
    const ids = nodeIds && nodeIds.length ? nodeIds : checkedReady.value.map(v => v.id);
    return runMerge(ids, { autoMajority: Boolean(allowTranscode) });
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
