import type { NodeMediaPriceRequest } from "@toonflow/nodes-scaffold/runtime";
import type { Kind } from "./generation";

export type MediaRef = { dataType: string; value?: unknown };
export type ModelChoice = { providerId: string; modelId: string };

export function modelChoice(raw: unknown): ModelChoice | undefined {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return; }
  }
  if (Array.isArray(raw) && typeof raw[0] === "string" && typeof raw[1] === "string" && raw[0] && raw[1]) {
    return { providerId: raw[0], modelId: raw[1] };
  }
  if (raw && typeof raw === "object") {
    const model = raw as Record<string, unknown>;
    const providerId = model.providerId ?? model.provider ?? model.vendor;
    const modelId = model.modelId ?? model.model ?? model.id ?? model.name;
    if (typeof providerId === "string" && providerId && typeof modelId === "string" && modelId) return { providerId, modelId };
  }
}

export function quoteRequest(kind: Exclude<Kind, "text">, id: string, data: Record<string, unknown>,
  directory: string, references: MediaRef[]): NodeMediaPriceRequest | undefined {
  const model = modelChoice(data.model ?? data);
  if (!model || !directory) return;
  const media = (type: string) => references.flatMap(({ dataType, value }) => {
    if (dataType !== type || !value || typeof value !== "object") return [];
    const file = value as { url?: string; mimeType?: string };
    return file.url && file.mimeType ? [{ path: file.url, mimeType: file.mimeType }] : [];
  });
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  const number = (value: unknown) => (typeof value === "number" || typeof value === "string" && value.trim())
    && Number.isFinite(Number(value)) ? Number(value) : undefined;
  const images = media("IMAGE"), audios = media("AUDIO"), videos = media("VIDEO");
  const prompt = [text(data.prompt)?.trim(), ...references.flatMap((ref, index) =>
    ref.dataType === "STRING" && typeof ref.value === "string" && ref.value.trim()
      ? [`参考 ${index + 1}：\n${ref.value.trim()}`] : [])].filter(Boolean).join("\n\n");
  const base = {
    ...model, directory, outputDirectory: `assets/${id}`,
    prompt,
    other: data.other && typeof data.other === "object" && !Array.isArray(data.other) ? data.other as Record<string, unknown> : undefined,
  };
  if (kind === "image") {
    if (data.inpaint) return;
    return { ...base, mediaType: kind, size: text(data.size), ratio: text(data.ratio), images };
  }
  if (kind === "audio") return {
    ...base, mediaType: kind, images, audios, language: text(data.language), format: text(data.format),
    sampleRate: number(data.sampleRate), speed: number(data.speed), volume: number(data.volume), pitch: number(data.pitch), voice: text(data.voice),
  } as NodeMediaPriceRequest;

  let mode = data.mode;
  if (typeof mode === "string" && /^[\["]/.test(mode.trim())) {
    try { mode = JSON.parse(mode); } catch { return; }
  }
  if (!(typeof mode === "string" || Array.isArray(mode) && mode.every(item => typeof item === "string"))) mode = undefined;
  const frameMode = typeof mode === "string" && ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode);
  const onlyLastFrame = frameMode && mode === "startFrameOptional" && images.length === 1;
  const firstFrame = frameMode && !onlyLastFrame ? images[0] : undefined;
  const lastFrame = frameMode ? images[onlyLastFrame ? 0 : 1] : undefined;
  const indexes = { image: 0, video: 0, audio: 0 };
  const referenceOrder = references.map(({ dataType, value }) => {
    if (!value) return { type: "text" };
    if (dataType === "VIDEO") return { type: "video", index: indexes.video++ };
    if (dataType === "AUDIO") return { type: "audio", index: indexes.audio++ };
    if (dataType === "IMAGE") {
      const index = indexes.image++;
      if (frameMode) return { type: index === 0 && firstFrame ? "firstFrame" : "lastFrame" };
      return { type: "image", index };
    }
    return { type: "text" };
  });
  return {
    ...base, mediaType: kind, images: frameMode ? undefined : images, audios, videos, firstFrame, lastFrame, referenceOrder,
    ratio: text(data.ratio), resolution: text(data.resolution), duration: number(data.duration),
    mode, generateAudio: typeof data.generateAudio === "boolean" ? data.generateAudio : undefined,
  } as NodeMediaPriceRequest;
}

export function totalQuote(prices: string[], count: number) {
  if (!prices.length) return "估价暂不可用";
  const amounts = prices.map(price => /^(?:约\s*)?(\d+(?:\.\d+)?)\s*([^\d]+)$/.exec(price.trim()));
  const unit = amounts[0]?.[2].trim();
  if (!unit || unit.includes("/") || amounts.some(amount => amount?.[2].trim() !== unit)) return "计价单位不同，请查看各节点";
  const value = amounts.reduce((sum, amount) => sum + Number(amount![1]), 0);
  const total = `约 ${Number(value.toFixed(2))} ${unit}`;
  return prices.length === count ? total : `${total}（已估 ${prices.length}/${count}）`;
}
