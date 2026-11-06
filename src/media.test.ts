import { expect, test } from "bun:test";
import { alignmentOptions, canvasFileName, concatList, inspectMedia, workspacePath } from "./media";

const video = { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p",
  time_base: "1/15360", r_frame_rate: "30/1", profile: "High", level: 40 };
const audio = { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", time_base: "1/48000", profile: "LC" };
const probe = (streams = [video, audio]) => inspectMedia({ streams, format: { duration: 2 } });

test("把音频声道、帧率和轨道顺序纳入流拷贝预检", () => {
  expect(probe().key).not.toBe(probe([video, { ...audio, channels: 1 } as typeof audio]).key);
  expect(probe().key).not.toBe(probe([{ ...video, r_frame_rate: "24/1" }, audio]).key);
  expect(probe().key).not.toBe(probe([audio, video]).key);
  expect(() => probe([video, audio, { codec_type: "subtitle" } as typeof audio])).toThrow("额外轨道");
});

test("对齐参数继承基准的帧率、时间基和声道，拒绝不支持的基准", () => {
  expect(alignmentOptions(probe())).toContain("-r 30/1");
  expect(alignmentOptions(probe())).toContain("-video_track_timescale 15360");
  expect(alignmentOptions(probe())).toContain("-ac 2");
  expect(() => alignmentOptions(probe([{ ...video, codec_name: "hevc" }, audio]))).toThrow("暂不支持");
  expect(() => alignmentOptions(probe([{ ...video, color_transfer: "smpte2084" }, audio]))).toThrow("暂不支持");
});

test("防止清单注入，正常保留中文、空格和引号", () => {
  expect(concatList(["assets/段 1's.mp4"], 4)).toBe("file '../../../../assets/段 1'\\''s.mp4'\n");
  for (const path of ["assets/../test.mp4", "/etc/passwd", "https://example.test/a.mp4", "a\nfile b"]) {
    expect(() => workspacePath(path)).toThrow("工作区");
  }
  expect(canvasFileName("工作/第一集.json")).toBe("第一集");
  expect(canvasFileName("..")).toBe("画布");
});
