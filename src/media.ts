export interface Stream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  time_base?: string;
  field_order?: string;
  profile?: string;
  level?: number;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  sample_rate?: string | number;
  channels?: number;
  channel_layout?: string;
  sample_fmt?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

export type MediaProbe = { streams?: Stream[]; format?: { duration?: string | number } };

export function inspectMedia(data: MediaProbe) {
  const streams = data.streams ?? [];
  const videos = streams.filter(stream => stream.codec_type === "video");
  const audios = streams.filter(stream => stream.codec_type === "audio");
  const [video] = videos, [audio] = audios;
  const duration = Number(data.format?.duration);
  if (videos.length !== 1 || video.disposition?.attached_pic || audios.length > 1 || streams.length !== videos.length + audios.length) {
    throw new Error("只支持一条视频轨和至多一条音轨，暂不合并带字幕、封面或额外轨道的文件");
  }
  if (!video.codec_name || !video.width || !video.height || !video.time_base || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("无法确认视频编码参数或时长");
  }
  if (audio && (!audio.codec_name || !Number(audio.sample_rate) || !audio.channels || !audio.time_base)) {
    throw new Error("无法确认音频编码参数");
  }
  const rotation = Number(video.side_data_list?.find(entry => entry.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const sar = video.sample_aspect_ratio === "N/A" || !video.sample_aspect_ratio ? "1:1" : video.sample_aspect_ratio;
  const key = JSON.stringify([
    streams.map(stream => stream.codec_type), video.codec_name, video.width, video.height, sar, video.pix_fmt,
    video.r_frame_rate, video.time_base, video.field_order, video.profile, video.level, rotation,
    video.color_space, video.color_transfer, video.color_primaries, video.color_range,
    audio?.codec_name, Number(audio?.sample_rate || 0), audio?.channels, audio?.channel_layout, audio?.profile, audio?.sample_fmt, audio?.time_base,
  ]);
  const short = `${video.width}x${video.height} · ${video.codec_name} ${video.r_frame_rate || ""} · ${audio
    ? `${audio.codec_name} ${audio.sample_rate}Hz ${audio.channels}ch` : "无音频"}`;
  return { duration, video, audio, rotation, sar, key, short };
}

export type Profile = ReturnType<typeof inspectMedia>;

export function workspacePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  if (/[\x00-\x1f\x7f:]/.test(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("素材路径必须是工作区内的普通文件路径");
  }
  return normalized;
}

export function concatList(paths: string[], depth: number) {
  return paths.map(path => `file '${"../".repeat(depth)}${workspacePath(path).replaceAll("'", "'\\''")}'\n`).join("");
}

export function canvasFileName(path: string) {
  const name = path.split(/[\\/]/).at(-1)?.replace(/\.json$/i, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim().replace(/[. ]+$/, "");
  const shortened = [...(name || "画布")].slice(0, 60).join("");
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(shortened) ? `_${shortened}` : shortened;
}

export function supportsAlignmentGeometry(profile: Profile) {
  return !profile.rotation && profile.sar === "1:1"
    && !["smpte2084", "arib-std-b67"].includes(profile.video.color_transfer ?? "");
}

export function alignmentOptions(target: Profile) {
  const { video, audio } = target;
  const profile = ({ "Constrained Baseline": "baseline", Baseline: "baseline", Main: "main", High: "high" } as Record<string, string>)[video.profile ?? ""];
  const timescale = /^1\/(\d+)$/.exec(video.time_base ?? "")?.[1];
  const fps = /^([1-9]\d*)\/([1-9]\d*)$/.test(video.r_frame_rate ?? "") ? video.r_frame_rate : undefined;
  const width = video.width!, height = video.height!;
  if (video.codec_name !== "h264" || !profile || !timescale || !fps || video.pix_fmt !== "yuv420p" || !supportsAlignmentGeometry(target)
      || width % 2 || height % 2 || (video.field_order && video.field_order !== "progressive")
      || (audio && (audio.codec_name !== "aac" || audio.profile !== "LC" || ![1, 2].includes(audio.channels!)))) {
    throw new Error("这个基准档暂不支持自动对齐。请选择常见的 H.264 / AAC 基准档，或只合并同档素材");
  }
  const options = [
    "-map 0:v:0", `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    "-c:v libx264", "-crf 18", "-preset medium", "-pix_fmt yuv420p", `-profile:v ${profile}`,
    `-r ${fps}`, `-video_track_timescale ${timescale}`,
  ];
  if (video.level && video.level > 0) options.push(`-level:v ${(video.level / 10).toFixed(1)}`);
  for (const [flag, value] of [
    ["colorspace", video.color_space], ["color_trc", video.color_transfer], ["color_primaries", video.color_primaries], ["color_range", video.color_range],
  ]) if (value && value !== "unknown" && /^[a-zA-Z0-9_-]+$/.test(value)) options.push(`-${flag} ${value}`);
  if (audio) options.push("-map 0:a:0", "-c:a aac", "-profile:a aac_low", `-ar ${Number(audio.sample_rate)}`, `-ac ${audio.channels}`);
  else options.push("-an");
  return options;
}
