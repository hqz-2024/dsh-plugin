---
name: dsh-video-studio
description: 当用户要求用工作空间里的素材切片批量制作、拼接、剪辑视频（产品展示视频、短视频混剪等），或要求分析视频内容、给视频打标、生成/更新 manifest.json 标注时使用。
---

# 视频批量剪辑（dsh-video-studio）

工作空间里有一批素材切片（可带标注），用 video_* 工具批量剪辑成片。FFmpeg 由插件内嵌、在服务器本地运行，用户无需安装。所有 FFmpeg 能力都可调用：语义化工具覆盖常用操作，`ffmpeg_run` 透传兜底覆盖任意长尾需求。

## 工具一览

| 工具 | 用途 |
|---|---|
| `video_list` | 读 manifest.json（可选），分类列出素材及 description/tags |
| `video_probe` | 查时长/分辨率/帧率/音轨 |
| `video_build` | 一站式：选片 + 剪切 + 变速 + 转场 + BGM + 字幕 + 出片 |
| `video_cut` | 单段剪切/变速/分辨率/静音 |
| `video_concat` | 多段拼接（硬切或 xfade 转场） |
| `video_audio` | 混 BGM/音量/去原音 |
| `video_subtitle` | 烧录 SRT/ASS 字幕 |
| `video_thumbnail` | 抽帧缩略图 |
| `video_convert` | 格式转换 / 提取音频 / 转 GIF / 抽帧成图 |
| `video_filter` | 常用滤镜（亮度/对比度/饱和度/模糊/锐化/黑白/旋转/翻转等） |
| `ffmpeg_run` | 透传任意 ffmpeg 参数（全功能兜底） |

## manifest.json（可选）

manifest.json 只是「标注」的结构化载体，**不是必须的**。写了它，AI 能按 category/description/tags 智能选片；不写，直接用文件路径给 video_build 的 `clips` 列表即可。

```json
{
  "clips": [
    { "file": "clips/p001.mp4", "category": "product", "product": "SKU-1024",
      "title": "耳机充电仓开合特写", "description": "白底旋转特写，展示外观材质",
      "tags": ["特写", "旋转"], "duration": 4.0 }
  ]
}
```

- `category`：常见 `product`（产品展示）/ `model`（模特展示）/ `feature`（功能讲解）。
- `description` + `tags`：用于精细选片。

## 视频标注（分析画面 → 生成 manifest.json）

当用户要求「分析视频内容」「给视频打标」「生成/更新 manifest.json」时，先判断是否要生成，再按需走标注流程（**需 vision 模型，否则 read_image 读不了图**）：

0. **先检查目录是否已有 manifest.json**：已有则不重复生成——把现有标注读出来，跟用户确认是否正确、是否有要修正处；没有 manifest 才走下面的生成流程。

1. **拿元数据**：对每个视频调 `video_probe`，得到时长/分辨率/帧率/音轨。
2. **抽帧**：按时长确定 3–5 个时间点（覆盖开头/中间/结尾；单镜头切片 1–3 帧够），用 `video_thumbnail` 或 `ffmpeg_run`（`-ss <秒> -i <视频> -frames:v 1 <输出.jpg>`）抽帧到临时目录。
3. **读图**：逐帧 `read_image`，理解画面内容。
4. **写标注**：按画面**实际看到的内容**写 `description`（物体/人物/动作/画面文字/品牌/参数）、`tags`（画面元素 + 产品特性），推断 `category`（product 产品展示 / model 模特展示 / feature 功能讲解）和 `product` 型号。
5. **落盘**：写/更新 manifest.json，每条保留 `file`/`duration`/`resolution` 等元数据字段。

要点：
- description 只写**画面里实际看到的**，不靠文件名臆测。
- 画面里的文字（包装箱参数、机身型号、字幕、品牌）要如实读入 description/tags。
- 发现**文件名与画面实物不符**时，在 `note` 字段标注差异，并提醒用户核对。
- 每条只记录 `resolution`（视频分辨率，如 "1920x1080" / "854x480"）一个字段，不额外区分原版/压缩版。

## 工作流程

1. 调 `video_list` 读清单（有 manifest 时），或直接 `video_probe` 看素材。
2. 按用户需求（产品、主题、时长、竖屏/横屏、是否要转场/BGM/字幕）动态决策选哪几段、什么顺序、各裁多长、是否变速。
3. 组 recipe 调 `video_build` 一步出片；或按需组合 `video_cut` → `video_concat` → `video_audio` → `video_subtitle`。
4. 调 `video_probe` 复检成片时长/分辨率。

## video_build 的 recipe 结构

```json
{
  "spec": { "width": 1080, "height": 1920, "fps": 30, "crf": 20, "fill": "fit" },
  "clips": [ { "file": "clips/p001.mp4", "start": 0, "trim_to": 3.0, "speed": 1 } ],
  "transition": { "type": "fade", "duration": 0.5 },
  "bgm": "assets/bgm.mp3", "bgm_volume": 0.8, "bgm_keep_original": true,
  "subtitle": "assets/sub.srt", "font": "Microsoft YaHei",
  "output": "out/成品-SKU1024.mp4"
}
```

- `clips`：精确选片顺序（推荐，可复现）。每条 file（相对工作区）、start（起始秒）、trim_to（输出秒数）、speed（变速）、mute（静音，可选）。
- `steps`（替代 clips）：`[ { "category": "product", "count": 1, "trim_to": 3.0 } ]` 按类别取前 N 段（需 manifest）。
- `spec` 可省略（默认竖屏 1080×1920@30，crf 20）；横屏设 width:1920,height:1080；fill=fit（留边）/crop（裁满）。
- `transition`/bgm/subtitle 均可省略。

## 关键语义

- **变速不变调**：`speed` 走 atempo（保音调）。speed 2 = 2 倍速（时长减半）。
- **转场**：`transition.type` 用 xfade 转场名（fade/wipeleft/slideright 等），duration 为叠化秒数。
- **字幕**：SRT 需指定中文字体（默认 Microsoft YaHei），否则中文变方块；ASS 自带样式。
- **长尾需求**：语义化工具覆盖不了的，用 `ffmpeg_run` 传参数数组（相对路径，相对工作区）。

## 注意

- 相对路径都相对工作区根目录解析；输出被沙箱收容在工作区内。
- 同工作区成员互相可见成片。