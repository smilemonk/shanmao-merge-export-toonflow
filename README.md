# Toonflow 山猫插件集

作者：山猫

为 [Toonflow](https://toonflow.net) 画布开发的节点插件集合。下载各插件 `build/` 目录下的 `.umd.js` 文件，在 Toonflow 设置的插件管理中安装即可使用。

## 插件一览

| 插件 | 干什么 | 一句话 |
| --- | --- | --- |
| [批量生成](shanmaoBatchGenerate) | 挑选画布上要生成的节点，按依赖分层批量执行，面板实时显示预计总费用 | 勾选→看价→执行 |
| [合并导出视频](shanmaoMergeExport) | 把画布上视频节点当前显示的素材按名称顺序合并成一个视频 | 选段→合并→成片 |

## 批量生成（shanmaoBatchGenerate）

- 分类快选：视频 / 图片 / 音频 / 文本 一键勾选一类，可叠加、可再逐个微调
- 未生成快选：一次勾上所有还没出结果的节点，补跑不碰已生成的，不重复扣费
- 按画布连线分层执行：同层同时提交，全部落定才进下一层；任一节点失败后停止提交新任务，已在跑的会跑完并保留结果
- 费用预估：通过 Toonflow 自带的估价功能汇总显示所选节点的预计总费用
- 默认零勾选——涉及费用，勾哪些由使用者自己决定

详见 [shanmaoBatchGenerate/readme.md](shanmaoBatchGenerate/readme.md)。

## 合并导出视频（shanmaoMergeExport）

- 列出画布上所有视频节点，按名称排序（段1 → 段2 → 段3 ……），勾选合并
- 各段编码参数一致时直接流拷贝拼接：画面、声音、时长与源文件完全一致，速度极快
- 参数不一致时（例如混了 720p 和 1080p）按参数分档列出，由你选择以哪一档为准，其余段自动转码对齐（画面保持原比例）
- 产物归档清晰：`合并导出视频/画布名字_日期时间.mp4`，每次导出都是新文件不覆盖；每次的素材清单留档在 `input/` 子目录可追溯
- 素材片段保留在原处，不额外复制，不占用额外空间

详见 [shanmaoMergeExport/readme.md](shanmaoMergeExport/readme.md)。

## 安装

1. 下载对应插件 `build/` 目录下的 `.umd.js` 文件
2. 打开 Toonflow → 设置 → 插件管理 → 安装该文件
3. 打开画布，右键添加对应节点

## 目录结构

```
Toonflow/
├── shanmaoBatchGenerate/   批量生成（源码 + 构建产物）
│   ├── src/                源码（Vue 组件 + 执行队列 + 估价模块 + 测试）
│   ├── build/              可直接安装的 UMD 产物
│   └── scripts/            构建脚本
└── shanmaoMergeExport/     合并导出视频（源码 + 构建产物）
    ├── src/
    └── build/
```

## 开发

- 节点插件基于 Toonflow 官方节点脚手架（`@toonflow/nodes-scaffold`）开发，Vue 3 + Element Plus 由宿主提供
- 构建产物为单文件 UMD，直接安装到 Toonflow 即可
- 欢迎在 [Issues](https://github.com/smilemonk/Toonflow/issues) 反馈问题与建议
