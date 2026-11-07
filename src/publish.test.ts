import { expect, test } from "bun:test";
import { publishExport } from "./publish";

const paths = { root: "导出", input: "导出/input/第一集", name: "第一集", partial: "staging/output.mp4" };
const collision = () => Object.assign(new Error("文件已存在"), { code: "EEXIST" });

test("普通导出只用画布名和日期时间", async () => {
  const writes: string[] = [];
  const result = await publishExport({
    async write(file, _content, exclusive) { expect(exclusive).toBe(true); writes.push(file); },
    async rename() {},
    async remove() { throw new Error("正常导出不需要清理清单"); },
  }, paths, "源素材清单", new AbortController().signal);
  expect(result).toMatch(/^导出\/第一集_\d{8}_\d{6}\.mp4$/);
  expect(writes[0].split("/").at(-1)?.replace(/\.txt$/, ".mp4")).toBe(result.split("/").at(-1));
});

test("只有撞名才加 _1、_2，已有清单和成片都不会覆盖", async () => {
  const writes: string[] = [], removed: string[] = [], renames: string[] = [];
  const result = await publishExport({
    async write(file, _content, exclusive) {
      expect(exclusive).toBe(true);
      writes.push(file);
      if (writes.length === 1) throw collision();
    },
    async remove(file) { removed.push(file); },
    async rename(_source, target) {
      renames.push(target);
      if (renames.length === 1) throw collision();
    },
  }, paths, "源素材清单", new AbortController().signal);
  const prefix = writes[0].slice(0, -4);
  expect(writes).toEqual([`${prefix}.txt`, `${prefix}_1.txt`, `${prefix}_2.txt`]);
  expect(removed).toEqual([`${prefix}_1.txt`]);
  expect(renames[0]).toMatch(/_1\.mp4$/);
  expect(result).toMatch(/^导出\/第一集_\d{8}_\d{6}_2\.mp4$/);
});

test("停止后不会删除已有清单或发布成片", async () => {
  const controller = new AbortController();
  const renamed: string[] = [], removed: string[] = [];
  await expect(publishExport({
    async write() { controller.abort(new Error("已停止")); throw collision(); },
    async rename(_source, target) { renamed.push(target); },
    async remove(file) { removed.push(file); },
  }, paths, "源素材清单", controller.signal)).rejects.toThrow("已停止");
  expect(renamed).toEqual([]);
  expect(removed).toEqual([]);
});
