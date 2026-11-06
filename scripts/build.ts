import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const cache = "/Applications/data/tools/pluginResources/pluginDeveloper/bundled";
const directories = process.env.TOONFLOW_PLUGIN_SDK ? [resolve(process.env.TOONFLOW_PLUGIN_SDK)]
  : (await readdir(cache, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => join(cache, entry.name));
const available = directories.filter(directory => Bun.file(join(directory, "pluginBuild.js")).size > 0);
if (available.length !== 1) throw new Error("请用 TOONFLOW_PLUGIN_SDK 指向要使用的官方 SDK 目录");
const sdk = available[0];

const manifest = await Bun.file(join(root, "plugin.json")).json();
const output = join(root, "build");
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, ".build-"));
const fileName = `${manifest.name}.umd.js`;
try {
  const child = Bun.spawn([process.execPath, join(sdk, "pluginBuild.js")], {
    stdin: new Blob([JSON.stringify({ root, outDir: staging, manifest: { configRules: [], github: "", prompt: "", ...manifest } })]),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited) throw new Error("官方 SDK 构建失败");
  const artifact = join(staging, fileName);
  const bundle = await readFile(artifact, "utf8");
  const notices = [await readFile(join(root, "scripts", "toonflow-sdk-notice.txt"), "utf8")];
  for (const name of ["@tabler/icons-vue", "zod", "eventsource-parser"]) {
    const directory = join(sdk, "thirdPartyNotices", name);
    const versions = await readdir(directory);
    if (versions.length !== 1) throw new Error(`无法确定 SDK 所带 ${name} 的许可证版本`);
    const version = versions[0];
    const notice = await readFile(join(directory, version, "LICENSE"), "utf8");
    notices.push(`${name} ${version}\n${notice}`);
  }
  const notice = notices.map(item => item.trim()).join("\n\n");
  const end = bundle.indexOf("\n");
  // GitHub 的相对图片路径只在仓库里有效，安装包内说明不请求这些图片。
  const header = /^\/\*! toonflowNode:(.*) \*\/$/.exec(bundle.slice(0, end));
  if (!header) throw new Error("官方 SDK 输出缺少节点元数据");
  const metadata = JSON.parse(header[1]);
  metadata.readme = metadata.readme.replace(/<!-- github-images:start -->[\s\S]*?<!-- github-images:end -->\n*/g, "");
  const banner = JSON.stringify(metadata).replaceAll("/", "\\u002f");
  await writeFile(artifact, `/*! toonflowNode:${banner} */\n/*!\n${notice.replaceAll("*/", "* /")}\n*/${bundle.slice(end)}`);
  await chmod(artifact, 0o644);
  await rename(artifact, join(output, fileName));
  console.log(join(output, fileName));
} finally {
  await rm(staging, { recursive: true, force: true });
}
