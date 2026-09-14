# dsh-video-studio

局域网 DSH 的视频工作室插件：内嵌 FFmpeg（用户零安装），提供 11 个模型工具，把工作区里的素材切片批量「剪切 + 变速 + 转场 + 配乐 + 字幕 + 拼接」成产品展示视频，并支持格式转换与常用滤镜。

## 能力

- 剪切、**变速（不变调）**、分辨率改变、裁剪/留边、静音
- 拼接：硬切或 **xfade 转场**
- **BGM** 混音（音量、去原音）
- **字幕**烧录（SRT/ASS，中文字体）
- **格式转换**：视频容器互转、提取音频、转 GIF、抽帧成图
- **常用滤镜**：亮度/对比度/饱和度/色相/模糊/锐化/黑白/反色/旋转/翻转
- **ffmpeg_run** 透传：任意 FFmpeg 参数（全功能兜底）

## 工具

| 工具 | 用途 |
|---|---|
| `video_list` | 读 manifest.json（可选），分类列出素材 |
| `video_probe` | 查时长/分辨率/帧率/音轨 |
| `video_build` | 一站式出片 |
| `video_cut` | 单段剪切/变速/分辨率/静音 |
| `video_concat` | 多段拼接（硬切/xfade） |
| `video_audio` | BGM 混音 |
| `video_subtitle` | 字幕烧录 |
| `video_thumbnail` | 抽帧 |
| `video_convert` | 格式转换 / 提取音频 / 转 GIF |
| `video_filter` | 常用滤镜 |
| `ffmpeg_run` | 透传任意 ffmpeg 参数 |

## 安装

1. **二进制**：install.ps1 含「下载 ffmpeg/ffprobe + SHA256 校验」（BtbN win64-gpl，各约 157MB）。
2. **装配**：profiles/web/package.json 已加 link: 依赖 + bundle；pnpm install 建链接。
3. **生效**：host 改动需整进程重启。

## 配置

cordis.patch.yml 的 config：`maxConcurrent`（并发渲染上限，默认 2）、`outputDir`（默认 out）。

## 测试

```
node test/features.mjs         # 全功能冒烟（变速/转场/BGM/字幕/静音等）
node test/convert-filter.mjs   # 格式转换 + 滤镜
node test/e2e.mjs              # 基础剪切拼接
```

## 许可证

FFmpeg 为 GPL 完整构建（含 libx264/libass），仅限公司内部使用。