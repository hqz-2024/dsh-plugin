# manifest 校对工具实施计划（dsh-manifest-tool：Electron 桌面应用）

> **For agentic workers:** 本计划按阶段推进，每阶段有独立验证标准。这是 dsh-video-studio 生态的配套桌面工具，与已有的服务端剪辑插件互补：AI 在服务端生成 manifest 第一版，员工在本机用本工具对着视频预览逐字段校对/修正，再上传回工作空间供选片出片。

**Goal:** 做一个 Electron 单窗口桌面应用，打包成 exe，让局域网用户在本地：①选目录后自动列出所有视频（ffmpeg 支持格式）；②点击视频在固定 50% 宽的中栏预览（帧级进度条、播放、快进、加速）；③在右栏以「标签 + 文本框」形式查看/编辑该视频的 manifest 字段，人工校对修正后保存回 manifest.json。exe 挂到 DSH 的「本地插件」设置页供局域网用户下载。

**Architecture:** Electron 主进程（Node）+ 渲染进程（Chromium）。主进程内嵌 ffmpeg/ffprobe（复用 dsh-video-studio-local/bin 的二进制），负责目录选择、ffprobe 扫描、读/写 manifest、IPC；渲染进程负责三栏 UI + `<video>` 预览。三栏布局：左栏视频列表（宽度可调）+ 中栏预览（固定约 50%）+ 右栏 manifest 表单（宽度可调）。

**Tech Stack:** Electron + 原生 HTML/CSS/JS（不引前端框架，保持轻量可维护）、electron-builder（打 Windows exe）、FFmpeg 静态二进制（BtbN win64-gpl，已就位 ~157MB × 2）。

---

## 1. 需求梳理（最终确认版）

### 1.1 布局

| 栏 | 内容 | 宽度 |
|---|---|---|
| 左栏 | 视频列表 | 可拖拽调节 |
| 中栏 | 视频预览 | 固定约 50% UI 空间 |
| 右栏 | manifest 字段表单（标签 + 文本框） | 可拖拽调节 |

### 1.2 manifest 字段逻辑

- **未标注的新视频**：点击后右栏固定生成显示 `file / category / product / title / description / tags / duration / resolution` 8 个字段（空值待填）。
- **已标注的视频**：有什么字段就显示什么字段（动态渲染该 clip 条目的全部字段）。
- **所有视频都能新增字段**：提供「+ 新增字段」按钮，动态加一个「字段名 + 文本框」。
- **允许新建**：未标注视频可填写字段后新建条目（初始就是上面 8 个固定字段）。
- **tags**：文本框内用逗号分隔（如 `开箱, 产品展示`），保存时转回数组。边界：单个 tag 内不含逗号。

### 1.3 保存

- **直接保存**：写回原 manifest.json（覆盖，保留其他条目与字段顺序）。
- **另存为**：弹保存对话框，存到用户指定路径（JSON 结构不变）。

### 1.4 语言

- UI 文案**默认中文，可切换英文**（顶部语言切换）。
- **字段值按 manifest 原样显示**：是英文就英文、中文就中文，不翻译字段内容。

---

## 2. 系统设计

### 2.1 主进程（main.js）

| 职责 | 实现 |
|---|---|
| 选择目录 | `dialog.showOpenDialog({ properties: ['openDirectory'] })` |
| 扫描视频 | 遍历目录 → 对候选文件跑 `ffprobe -show_streams`，探测出 video 流的列入；返回 `{ file, duration, width, height, fps }` |
| 读 manifest | 读目录下 manifest.json → 解析 clips 数组 → 按 `file` 建索引 |
| 写 manifest | 保存/另存为：把右栏编辑结果合并回 clips（按 file 匹配，无则新建），整文件写回 |
| FFmpeg 定位 | 打包时作 extraResources，用 `process.resourcesPath` 相对定位 |

IPC 通道：`select-dir` / `list-videos` / `read-manifest` / `save-manifest` / `save-as-manifest`。

### 2.2 渲染进程（三栏）

- **左栏**：视频列表项 = 文件名 + 时长 + 分辨率；点击切换；当前项高亮。
- **中栏**：`<video>` 预览。
  - 帧级进度条：`帧号 = round(currentTime × fps)`，拖动按 `帧号 / fps` seek；
  - 控件：播放/暂停、快进（±1 帧 / ±1 秒 / ±10 秒）、加速（0.5× / 1× / 2× / 4×）；
  - 显示：当前帧 / 总帧 + 当前时间 / 总时长。
- **右栏**：manifest 表单。
  - 已标注：动态渲染该 clip 的所有字段（标签 + 文本框，`description` 用多行）；
  - 未标注：固定 8 字段空表单 + 「新建」按钮；
  - 「+ 新增字段」动态加一行；
  - `tags` 文本框逗号分隔展示；
  - 底部「直接保存」「另存为」。

### 2.3 打包

electron-builder：Windows 目标（NSIS 安装包 + portable 可选），`ffmpeg.exe` / `ffprobe.exe` 作 extraResources，主进程用 `process.resourcesPath` 定位，用户无需装 FFmpeg。

### 2.4 DSH 集成（供局域网下载）

- 打包产物（exe 或 zip）放服务器 `~/.dsh/plugins/dsh-video-studio-local/assets/`；
- 插件 host 注册下载端点 `/dsh-video-studio/manifest-tool`（照抄 dsh-local-bridge serve sidecar.mjs 的写法）；
- 设置页「本地插件」加「manifest 校对工具」下载按钮（client.js）。

---

## 3. 实施计划

### P0：Electron 工程骨架 + 三栏布局

**Files:**
- Create: `dsh-manifest-tool/`（package.json + main.js + preload.js + renderer/index.html + renderer/renderer.js + renderer/style.css）

- [ ] Step 1: package.json（electron devDependency，`main: main.js`）
- [ ] Step 2: 三栏布局（左/中/右，中栏 50%，左右栏可拖拽，CSS flex + 拖拽分割条）
- [ ] Step 3: 空壳跑通（`electron .` 打开窗口，三栏可见）

**验收:** `pnpm exec electron .` 弹窗，三栏比例正确，中栏约 50%。

### P1：主进程（目录选择 + ffprobe 扫描 + 读 manifest）

- [ ] Step 1: 选目录对话框 + IPC `select-dir`
- [ ] Step 2: ffprobe 扫描（复用二进制，探测 video 流）
- [ ] Step 3: 读 manifest.json + 建 file 索引
- [ ] Step 4: 左栏渲染视频列表

**验收:** 选目录后左栏列出所有视频（含时长/分辨率），能读到 manifest。

### P2：视频预览（中栏）

- [ ] Step 1: `<video>` 绑定当前视频
- [ ] Step 2: 帧级进度条（currentTime × fps 换算帧号）
- [ ] Step 3: 播放/暂停 + 快进（±1 帧/±1 秒/±10 秒）+ 加速（0.5/1/2/4×）

**验收:** 点击左栏视频，中栏播放流畅，进度条显示到帧，快进/加速可用。

### P3：manifest 表单（右栏）+ 保存

- [ ] Step 1: 已标注视频 → 动态渲染所有字段
- [ ] Step 2: 未标注视频 → 固定 8 字段空表单 + 「新建」
- [ ] Step 3: 「+ 新增字段」动态加行
- [ ] Step 4: tags 逗号分隔 ↔ 数组转换
- [ ] Step 5: 直接保存（写回原 manifest）+ 另存为（保存对话框）

**验收:** 编辑字段 → 保存 → manifest.json 正确更新（新建/新增字段/改 tags 都对）。

### P4：i18n + 打包 exe

- [ ] Step 1: UI 文案中文默认 + 英文切换（字典文件）
- [ ] Step 2: electron-builder 配置 + FFmpeg extraResources
- [ ] Step 3: 打包出 exe，新机器解包验证（不依赖系统 FFmpeg）

**验收:** exe 可独立运行，选目录/扫描/预览/编辑/保存全流程可用，UI 可切中英文。

### P5：DSH 下载集成

- [ ] Step 1: 插件 host 注册 `/dsh-video-studio/manifest-tool` 下载端点
- [ ] Step 2: 设置页「本地插件」加下载按钮
- [ ] Step 3: 局域网用户下载 exe → 本机跑通

**验收:** 员工从 DSH 设置页下载 exe，本机运行能校对共享工作空间里的 manifest。

---

## 4. 风险与边界

| 风险/边界 | 影响 | 缓解 |
|---|---|---|
| Electron + FFmpeg 体积 ~300MB | 下载/分发较重 | 公司内网可接受；portable 版减小安装负担 |
| 帧级 seek 精度 ±1~2 帧（受 keyframe 影响） | 预览定位非严格逐帧 | 用户已确认接受「毫秒级、显示到帧」 |
| tags 逗号分隔的歧义 | 单个 tag 含逗号会拆错 | 约定 tag 内不含逗号（写入 plan 边界） |
| FFmpeg 打包路径定位 | 换机找不到二进制 | `process.resourcesPath` 相对定位 + 启动自检 |
| 字段值含中文的编码 | JSON 读写乱码 | 读写全程 UTF-8，保存时保留原格式 |

## 5. 附录

**A. 固定字段清单（未标注/新建时生成）**

`file / category / product / title / description / tags / duration / resolution`（共 8 个）。

**B. 与 dsh-video-studio 插件的关系**

- 插件（服务端）：AI 读视频生成 manifest + 选片出片；
- 本工具（客户端）：人工校对/修正 manifest；
- 闭环：AI 生成 → 员工本机校对 → 上传工作区 → AI 选片出片。
