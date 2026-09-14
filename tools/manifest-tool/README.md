# manifest 校对工具

局域网 DSH 的配套桌面工具（Electron）：本地预览视频 + 人工校对/修正 manifest.json。AI 在服务端生成 manifest 第一版，员工用本工具对着视频预览逐字段核对修正，再上传回工作空间供选片出片。

## 功能

- **三栏布局**：左栏视频列表（可调宽）+ 中栏视频预览（固定 50%）+ 右栏 manifest 表单（可调宽），左右栏拖拽分割条调宽。
- **视频扫描**：ffprobe 探测，ffmpeg 支持的全格式（按视频扩展名过滤，排除图片/字幕）。
- **帧级预览**：毫秒级 seek、显示到帧、播放/暂停、快进（±1 帧 / ±1 秒 / ±10 秒）、加速（0.5× / 1× / 2× / 4×）、键盘快捷键（空格播放、←/→ 逐帧）。
- **manifest 编辑**：
  - 已标注视频 → 动态显示该条目所有字段；
  - 未标注视频 → 固定 8 字段（file / category / product / title / description / tags / duration / resolution），file/duration/resolution 自动预填；
  - 「+ 新增字段」内联输入（支持回车确认 / Esc 取消）；
  - tags 用逗号分隔（中英文逗号都支持，保存时转回数组）；
  - 直接保存（写回原 manifest.json）+ 另存为。
- **语言**：UI 中文默认可切英文；字段值按 manifest 原样显示（是英文就英文、中文就中文）。

## 开发运行

```powershell
npm install
npm start        # 即 electron .
```

开发模式下 ffprobe 定位到 `~/.dsh/plugins/dsh-video-studio-local/bin/ffprobe.exe`（复用插件二进制）；打包后改走 `process.resourcesPath/ffmpeg/`。

## 打包

```powershell
# 1) 准备内嵌 FFmpeg（打包用，gitignore）
New-Item -ItemType Directory -Force ffmpeg
Copy-Item ~/.dsh/plugins/dsh-video-studio-local/bin/ffmpeg.exe ffmpeg/
Copy-Item ~/.dsh/plugins/dsh-video-studio-local/bin/ffprobe.exe ffmpeg/

# 2) 打包 portable 单文件 exe
npx electron-builder --win portable
```

产物：`dist/manifest-tool.exe`（约 151MB，含 Electron + FFmpeg，用户零安装）。

> 中国网络需镜像：`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`；内部工具无需代码签名时设 `CSC_IDENTITY_AUTO_DISCOVERY=false`（避免 winCodeSign 在 Windows 上解符号链接报错）。

## 使用流程

1. 打开 exe → 「选择目录」选中共享的工作空间目录。
2. 左栏点视频 → 中栏预览（拖进度条按帧定位、快进、加速）。
3. 右栏核对/修正字段（未标注的视频填好字段）。
4. 「直接保存」写回 manifest.json，或「另存为」存副本。

## 目录结构

```
manifest-tool/
├── package.json       # electron + electron-builder + build 配置
├── main.js            # 主进程：选目录 / ffprobe 扫描 / 读写 manifest / IPC
├── preload.js         # contextBridge 桥接
├── renderer/
│   ├── index.html     # 三栏布局
│   ├── style.css      # 样式（拖拽分割条 / 进度条 / 表单）
│   └── renderer.js    # 列表 / 预览 / 表单 / i18n 逻辑
├── test-scan.js       # 独立扫描逻辑验证脚本（node test-scan.js <目录>）
├── ffmpeg/            # 内嵌 FFmpeg（打包用，gitignore）
└── dist/              # 打包产物（gitignore）
```

## 与 DSH 的关系

- 源码在此目录；打包产物 `manifest-tool.exe` 由 `install.ps1` 的 **7c 步骤**生成，复制到 `~/.dsh/plugins/dsh-video-studio-local/assets/`。
- 插件 host 端点 `/dsh-video-studio/manifest-tool` serve 该 exe，设置页「本地插件」显示下载按钮。
- 员工下载后在本机运行。本工具**不直接连 DSH**，只读写本地目录（共享工作空间）里的 manifest.json——AI 在服务端生成的 manifest 由员工在本机核对修正后再回传。

## 边界

- 帧级进度条是「毫秒级 seek、显示到帧」，实际定位受视频 keyframe 影响可能 ±1~2 帧，预览用途够用。
- tags 逗号分隔约定单个 tag 内不含逗号。
