# 视频工作室插件实施计划（dsh-video-studio：FFmpeg 内嵌 + AI 选片 + 批量剪辑）

> **For agentic workers:** 本计划按阶段推进，每阶段有独立验证标准。P0 为决策前置，P1–P4 为实施，P5 可选，P6 为整体验收。核心原则不变：**引擎 checkout 零改动，所有定制落在 ~/.dsh**。

**Goal:** 在现有 hqz-dsh 局域网单实例部署上新增一个 DSH 原生插件 `dsh-video-studio`，内嵌 FFmpeg 静态二进制（用户零安装），让员工把工作空间里的 3–5 秒素材切片批量「剪切 + 拼接」成产品展示视频。成品规格（分辨率/帧率）、转场、BGM、字幕全部可调；AI 读取素材的 description/tags 动态选片。

**Architecture:** host 插件（内嵌 FFmpeg + 注册模型工具 + 服务器本地 spawn）+ 全局 skill（教 AI 读标注选片）+ 可选 client 插件（Web UI 预览/拖拽）。FFmpeg 在 **dsh 所在服务器本地** spawn，不走 dsh-local-bridge（sidecar 目标是每用户本机，而素材与 FFmpeg 都在服务器）。

**Tech Stack:** DeepSeek Harness 0.1.2-alpha.3（本地 checkout，零改动）、cordis 双半区插件（host `lib/index.js` + client `lib/client.js`）、`@deepseek-ai/dsh-tools` 的 `defineTool`、FFmpeg 静态构建（BtbN/gyan.dev，GPL 完整版）、现有 folder-tree-sh（素材上传/文件树）、全局 skill。

---

## 1. 可行性评估

### 结论：可行，且全部复用现有部署能力

| 需求 | 现状 | 证据 | 结论 |
|---|---|---|---|
| 素材上传到服务器 | folder-tree-sh 已提供共享工作空间 + 浏览器上传（含文件夹上传） | ~/.dsh/plugins/folder-tree-sh-local（P8.6 已修 upload/mkdir/for-await） | ✅ 直接复用，不新增上传 |
| FFmpeg 用户零安装 | 静态二进制随插件分发，host 用绝对路径 spawn | dsh-doc 已有「运行时下载 + SHA256 校验」先例（OCR ~178MB） | ✅ 内嵌 `bin/ffmpeg.exe` + `ffprobe.exe` |
| 服务器本地跑 FFmpeg | host 插件直接 `child_process.spawn` | dsh-doc 在服务器 spawn Python；dsh-local-bridge 演示 spawn 封装 | ✅ 不走 sidecar |
| 注册模型工具 | `defineTool` + `ctx.get('tools').register(tool)` | dsh-local-bridge 的 `local_run` 完整样板（见附录 A） | ✅ 照抄模式 |
| 多用户隔离 | 输出到会话 cwd（工作空间）+ 沙箱收容 | P5.1 已钉 `finance-confined`（workspace-write）；office_xlsx_write 路径经 sandboxPolicy 收容 | ✅ 复用 |
| AI 动态选片 | 全局 skill 教 AI 读 manifest 决策 | skill-filesystem 按 scope 分层，~/.dsh/skills 全局可见 | ✅ 加一个 SKILL.md |
| 并发 ≤3 人 | 简单信号量限流 FFmpeg 任务 | 无现成，插件内自建 | ✅ 自建（P2） |

### 必须明确的边界（不解决会翻车）

1. **许可证**：完整 GPL 构建含 libx264（H.264 编码必需）。**公司内部使用合规无碍**；若日后对外分发插件，需整插件 GPL 开源或换 LGPL 精简构建（编码能力受限）。本计划默认 GPL 完整版。
2. **体积**：完整构建 ffmpeg.exe 数百 MB 级。可接受（已有 178MB OCR 先例）；P0 提供「完整版 / 精简版」决策点。
3. **转场 ≠ 硬切**：`xfade` 需要所有片段先统一分辨率/帧率/像素格式，再用 filter_complex 链式串联并计算每个转场的时间偏移——复杂度高于 concat 硬切。本计划 P2 按「硬切 → 转场」递进。
4. **中文字幕字体**：`subtitles`/ASS 滤镜（libass）在完整构建内；中文字幕必须显式指定字体（如 Microsoft YaHei）与 `fontsdir`，否则中文显示为方块。
5. **Windows 路径**：素材/输出路径可能含空格或中文，spawn 必须用参数数组（`spawn(exe, [...args])`）而非 shell 字符串，避免引号/编码问题。
6. **CPU 负载**：FFmpeg 重编码很吃 CPU，3 人同时跑若无限制会打满服务器；P2 内置并发上限（默认 2 个并发渲染，其余排队）。

---

## 2. 系统设计

### 2.1 组件拓扑

```
员工浏览器 ──HTTPS──> caddy(8443) ──HTTP──> dsh(127.0.0.1:3080)
                                            ├─ dsh-video-studio (host)
                                            │    ├─ bin/ffmpeg.exe + ffprobe.exe（内嵌）
                                            │    ├─ 模型工具 video_probe/list/build/thumbnail
                                            │    └─ spawn FFmpeg（服务器本地）
                                            ├─ folder-tree-sh（工作空间上传/文件树，复用）
                                            ├─ skill: dsh-video-studio（AI 选片）
                                            └─ (P5) dsh-video-studio (client: 预览/拖拽)
```

### 2.2 插件结构

```
~/.dsh/plugins/dsh-video-studio-local/
├── package.json          # name: dsh-video-studio；dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert 一行 id/name（照抄 folder-tree-sh）
├── lib/
│   ├── index.js          # host：defineTool + FFmpeg 封装 + 并发信号量
│   ├── ffmpeg.js         # spawn 封装（probe/cut/concat/xfade/bgm/subtitle）
│   └── client.js         # (P5) Web UI
├── bin/                  # P0 下载 + SHA256 校验，gitignore
│   ├── ffmpeg.exe
│   └── ffprobe.exe
├── README.md / AGENTS.md
└── test/                 # node --test，照抄 dsh-local-bridge 的 role-gate.test.js 风格
```

全局 skill：`~/.dsh/skills/dsh-video-studio/SKILL.md`。

### 2.3 模型工具设计（ctx.tools，照抄 local_run 样板）

| 工具 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `video_probe` | path | {duration,width,height,fps,hasAudio,codec} | ffprobe 探测，选片/校验用 |
| `video_list` | dir | 按 category 分组的素材列表（含 description/tags） | 读 manifest.json |
| `video_build` | recipe(JSON) | {output, summary} | 主工具：选片+剪切+拼接+转场/BGM/字幕，一步出片 |
| `video_thumbnail` | path, at(秒) | 缩略图路径 | 抽帧，P2 校验 + P5 预览用 |

**recipe 结构（可调规格全在这里，JSON 描述）：**

```json
{
  "manifest": "manifest.json",
  "spec":   { "width": 1080, "height": 1920, "fps": 30, "crf": 20 },
  "steps":  [
    { "category": "product", "count": 1, "trim_to": 3.0 },
    { "category": "model",   "count": 1, "trim_to": 4.0 },
    { "category": "feature", "count": 2, "trim_to": 3.5 }
  ],
  "transition": { "type": "xfade", "transition": "fade", "duration": 0.5 },
  "bgm":     "assets/bgm.mp3",
  "subtitle": "assets/sub.srt",
  "output":  "out/成品-SKU1024.mp4"
}
```

- `spec` 空 → 默认竖屏 1080×1920@30；分辨率/帧率随素材质量任意调。
- `transition` 空 → 硬切（concat demuxer）；有 → xfade filter_complex 链。
- `bgm`/subtitle 可选；无则跳过。
- `trim_to` 按素材 `duration` 裁剪；超长自动截断。

**manifest 结构（员工在素材旁维护，AI 与工具都读它）：**

```json
{
  "clips": [
    { "file": "clips/p001.mp4", "category": "product", "product": "SKU-1024",
      "title": "耳机充电仓开合特写", "description": "白底旋转特写，展示外观材质",
      "tags": ["特写", "旋转"], "duration": 4.0 }
  ]
}
```

- `category` ∈ product/model/feature（三类素材）；`product` 用于按产品筛选；`tags` + `description` 供 AI 精细选片。

### 2.4 AI 动态选片

- 全局 skill `dsh-video-studio/SKILL.md` 教 AI：先 `video_list` 读清单 → 按 `description`/`tags` 决策「取哪几段、什么顺序、裁多长」→ 拼出 recipe → `video_build` 出片。
- 选片结果落在 recipe JSON，可复现、可审查，符合「模型可见即日志」约束（recipe 由工具参数/结果记录进会话日志）。
- 员工自然语言需求（如「做一条突出降噪功能的竖屏 15 秒短片」）由 AI 转成 recipe，不要求员工懂 FFmpeg。

### 2.5 并发与隔离

- **并发**：插件内信号量，默认同时最多 2 个 FFmpeg 渲染（3 人上限够用），超出排队；可在 cordis.patch.yml 调 `maxConcurrent`。
- **隔离**：每次构建用独立临时目录（`os.tmpdir()` 下按任务 id），输出写到会话 cwd（工作空间）；工具路径经 sandboxPolicy 收容（workspace-write 会话仅限工作区，与 office_xlsx_write 一致）。
- **清理**：临时目录任务结束即删；成片由用户自行管理（folder-tree-sh 可预览/删除）。

---

## 3. 实施计划

### P0：FFmpeg 二进制选型与获取（决策前置）

**决策：BtbN/FFmpeg-Builds 完整 GPL 构建（win64-gpl，含 libx264/libass/libmp3lame）。备选 gyan.dev（release-full.7z）。**

**Files:**
- Create: `~/.dsh/plugins/dsh-video-studio-local/bin/`（下载产物，gitignore）

- [ ] **Step 1: 下载并校验**
  从 BtbN releases 下载 `ffmpeg-master-latest-win64-gpl.zip` → 解出 `bin/ffmpeg.exe` + `bin/ffprobe.exe` → 对照 release 的 SHA256SUMS 校验。
- [ ] **Step 2: 验证可跑**
  `ffmpeg.exe -version`、`ffprobe.exe -version` 输出正常；`ffmpeg -encoders | findstr x264` 命中 libx264；`ffmpeg -filters | findstr xfade/subtitles` 命中。
- [ ] **Step 3: 决策记录**
  见附录 B（本文件下方）。

**验收:** 两条二进制在服务器可独立运行；x264/xfade/libass 三能力在位。

### P1：host 插件骨架 + 装配

**Files:**
- Create: `~/.dsh/plugins/dsh-video-studio-local/package.json`（name `dsh-video-studio`、`dsh.bundle.patch`、依赖仅 node 内置 + 可选 zod）
- Create: `~/.dsh/plugins/dsh-video-studio-local/cordis.patch.yml`（insert id/name）
- Create: `~/.dsh/plugins/dsh-video-studio-local/lib/index.js`（`name`/`inject`/`apply`；defineTool 注册 video_probe/video_list/video_thumbnail；`lib/ffmpeg.js` spawn 封装）
- Modify: `~/.dsh/profiles/web/package.json`（deps + bundles 增 `dsh-video-studio`，`link:../../plugins/dsh-video-studio-local`）

- [ ] **Step 1: 搭骨架**
  照抄 folder-tree-sh 的 package.json（`dsh.bundle.patch` + `main: lib/index.js`）与 cordis.patch.yml（insert 一行）。
- [ ] **Step 2: 实现 FFmpeg 定位与 spawn**
  `ffmpegPath() = fileURLToPath(new URL('../bin/ffmpeg.exe', import.meta.url))`；`spawn(exe, args)` 用参数数组 + `stdio: pipe` 收集 stdout/stderr（host 进程内，不受 agent 沙箱 EPERM 限制）。
- [ ] **Step 3: 注册 probe/list/thumbnail**
  照抄 dsh-local-bridge 的 `defineTool({ name, description, parameters, output:{schema,render}, execute, presentCall })` + `ctx.get('tools').register(tool)` 放进 `ctx.effect`。
- [ ] **Step 4: 装配 + 挂载校验**
  profile 依赖改 `link:`，fork 目录内单独 `pnpm install`（link: 不会装被链包自己的依赖，dsh-usage-panel 教训）；重启后确认工具出现在会话工具列表。

**验收:** 三工具注册成功、会话可见；`video_probe` 对工作区任意 mp4 返回正确元数据。

### P2：核心 video_build（递进：硬切 → 转场 → BGM → 字幕）

**Files:**
- Modify: `~/.dsh/plugins/dsh-video-studio-local/lib/ffmpeg.js`（新增 cut/concat/xfade/bgm/subtitle）
- Modify: `~/.dsh/plugins/dsh-video-studio-local/lib/index.js`（新增 video_build + 并发信号量）
- Create: `~/.dsh/plugins/dsh-video-studio-local/test/build.test.js`（node --test）

- [ ] **Step 1: 硬切基线**
  选片 → 每段 `-ss/-t` 精确剪切 + 统一 scale/pad/fps + h264/yuv420p + AAC（无音轨补 anullsrc）→ concat demuxer 无损拼。**先跑通端到端。**
- [ ] **Step 2: 转场**
  recipe 有 `transition` 时改走 filter_complex 链：N 段 = N-1 个 `xfade`，逐个算 offset；转场类型 fade/wipe/slide 白名单化。
- [ ] **Step 3: BGM**
  recipe 有 `bgm` 时拼接后 `amix`（或 -shortest 截到成片长度）；支持音量 `bgm_volume`。
- [ ] **Step 4: 字幕**
  recipe 有 `subtitle` 时烧录：`subtitles=sub.srt:fontsdir=...:force_style='FontName=Microsoft YaHei'`（中文字体）；预留 ASS 支持。
- [ ] **Step 5: 并发信号量**
  `maxConcurrent`（默认 2）+ FIFO 队列 + 任务去重；`video_build` 返回 {output, 时长, 段数, 规格}。
- [ ] **Step 6: 单测**
  node --test 覆盖：cut 时长精确、concat 段数正确、无音轨补静音、xfade 偏移、字幕字体参数、路径含空格/中文。

**验收:** 用 3 段测试切片跑通「硬切出片」；再各验一条「转场」「BGM」「字幕」成片；并发 3 个请求时第 3 个排队不报错。

### P3：全局 skill（AI 动态选片）

**Files:**
- Create: `~/.dsh/skills/dsh-video-studio/SKILL.md`（frontmatter: name + description 触发条件）

- [ ] **Step 1: 写 SKILL.md**
  内容：读 manifest → 理解三类素材 → 按 description/tags 决策选片 → 组 recipe → 调 video_build → 校验成片（video_probe 复检时长/分辨率）。
- [ ] **Step 2: 验证**
  新会话触发 skill（热更新即生效）→ 给 AI 一句需求 → AI 产出 recipe 并出片，选片理由可解释。

**验收:** 员工用自然语言描述需求，AI 自动选片 + 出片，全程不写 FFmpeg 命令。

### P4：install.ps1 下载步骤 + 端到端验收

**Files:**
- Modify: `~/.dsh/install.ps1`（新增「下载 FFmpeg 二进制 + SHA256 校验」步骤，幂等）
- Modify: `~/.dsh/verify.ps1`（新增断言：bin/ffmpeg.exe 存在 + `-version` 通过 + 插件在 bundles）
- Modify: `~/.dsh/README.md`（功能清单 + 用法）

- [ ] **Step 1: 下载步骤**
  复用 OCR 运行时的下载模式（Invoke-WebRequest + 解压 + SHA256 校验 + 幂等跳过）。
- [ ] **Step 2: 端到端验收（重启后）**
  三条测试切片上传工作空间 → 写 manifest.json → AI 对话出片 → folder-tree-sh 预览成片 → 转场/BGM/字幕各验一条。

**验收:** 全新机器跑 `install.ps1` 即得可用插件；员工零手动装 FFmpeg。

### P5（可选）：Web UI（预览 / 拖拽 / 一键出片）

**Files:**
- Create: `~/.dsh/plugins/dsh-video-studio-local/lib/client.js`（+ package.json `dsh.client` 段）

- [ ] **Step 1: 预览**
  `video_thumbnail` 抽帧网格 + `video_probe` 元数据；`dsh-client-connection` RPC 通道（照抄 usage-panel 的 /usage-stats 通道）。
- [ ] **Step 2: 拖拽排序 + 一键出片**
  客户端拖拽片段顺序 → 生成 recipe → 调 host 出片 → 进度/结果回显。
- [ ] **Step 3: 门禁**
  非 admin 仅限映射工作区（照抄 folder-tree-sh 的 per-user 收容）。

**验收:** 员工在 UI 拖拽选片、预览、出片，无需打字。

### P6：整体验收

- [ ] **Step 1: 三账号剧本**
  admin / 两个员工账号各开会话 → 上传切片 → 出片 → 互不干扰（隔离 + 并发 ≤3）。
- [ ] **Step 2: 记录结论**（附录 C：实测结果表）

---

## 4. 风险与开放问题

| 风险/问题 | 影响 | 缓解 |
|---|---|---|
| FFmpeg GPL 许可证 | 对外分发受限 | 内部用无碍；对外换 LGPL 精简构建（P0 决策点） |
| 体积数百 MB | 安装/迁移变重 | 已有 178MB OCR 先例；可选精简构建 |
| xfade 复杂度高于硬切 | P2 进度 | 硬切先行，转场独立递进，单测覆盖 |
| 中文字幕缺字体 | 字幕方块 | force_style 指定 Microsoft YaHei + fontsdir |
| 并发打满 CPU | 服务器卡顿 | 信号量限流（默认 2），cordis.patch.yml 可调 |
| 路径空格/中文 | spawn 失败 | 全程参数数组，不用 shell 字符串 |
| 成片/临时文件占磁盘 | 磁盘耗尽 | 临时目录任务结束即删；输出归用户工作区 |

## 5. 附录

**A. 工具注册样板（dsh-local-bridge/local_run，已核对）**

- `defineTool` 从 `@deepseek-ai/dsh-tools` 解析（`createRequire(dshHomePath()/profiles/web/package.json).resolve('@deepseek-ai/dsh-tools')`）。
- 注册：`ctx.effect(() => { const dispose = ctx.get('tools')?.register(tool); return () => dispose?.(); }, '...')`。
- `execute(args, exec)` 里 `exec.agent.session.id` 取会话 id（用于归属/沙箱路由）；返回值必须精确匹配 `output.schema`（additionalProperties: false）。
- `presentCall(args)` 返回工具调用卡片（`{ card:'generic', title, kind, rawInput }`）。

**B. P0 选型记录**

| 维度 | BtbN/FFmpeg-Builds win64-gpl（✅ 首选） | gyan.dev release-full（备选） |
|---|---|---|
| 分发 | GitHub releases，脚本化下载 + SHA256SUMS | 独立站点 .7z，需解析页面 |
| 能力 | 含 libx264/libass/libmp3lame，ffmpeg+ffprobe | 含 ffmpeg/ffprobe/ffplay，full 版同样全 |
| 校验 | release 自带 SHA256SUMS | 站点提供 sha256 文件 |
| 体积 | 数百 MB 级 | 相近 |

**C. 验收实测结果**：待 P4/P6 执行后回填。

**D. 改动记录（CHANGELOG）**：本插件全部改动集中在 `~/.dsh/plugins/dsh-video-studio-local/` + `~/.dsh/skills/dsh-video-studio/` + `install.ps1`/`verify.ps1`/`README.md`/`profiles/web/package.json`；核心 checkout 保持只读。host 改动整进程重启生效，client 改动 HMR + Ctrl+F5。

### D1 已修复问题

- **ffmpeg_run 返回结构不符合 schema（2026-09-07）**：`ffmpeg_run` 实际执行成功、成片正常生成，但返回时报 `tool "ffmpeg_run" returned invalid output: "value.error" must be a string`。根因：底层 `run()` 成功时返回 `error: null`，execute 把 `error`（null）和 `exitCode`（spawn 失败时为 null）原样透传，而 schema 里二者声明为 `string`/`number`，null 触发校验失败——不影响产物，但让调用方误以为失败。修复：execute 改为按类型条件性携带字段（`typeof res.code === 'number'` 才带 exitCode；`res.error` 非空才带 error），render 同步加固 `!v` 与 `typeof v.exitCode === 'number'` 判断。

### D2 工具集扩展（2026-09-10）

- **video_convert**：格式转换——视频容器互转（mp4/mov/mkv/webm/avi/ts/flv）、提取音频（mp3/wav/aac/m4a/flac/ogg）、转 GIF（调色板 + 缩放 + 帧率）、抽帧成图（jpg/png/webp）；按输出扩展名自动选编码器。
- **video_filter**：常用滤镜 11 种（brightness / contrast / saturation / hue / blur / sharpen / grayscale / negate / rotate / hflip / vflip），支持链式叠加。
- **工具数 9 → 11**；skill 增加「视频标注（抽帧读图生成 manifest）」流程，规则：目录已有 manifest 则不重复生成、先跟用户确认；每条只记 `resolution`、不区分 variant。

### D3 P4 完成：install.ps1 + verify.ps1 纳入 FFmpeg（2026-09-10）

- install.ps1 新增 7b 步骤：下载 BtbN win64-gpl FFmpeg（~185MB）+ SHA256 校验 + 解压 ffmpeg/ffprobe 到插件 bin/；$Plugins 加 dsh-video-studio-local（5 个）、$Skills 加 dsh-video-studio（10 个）。
- verify.ps1：skill 清单加 dsh-video-studio；dsh-video-studio-local 单独校验（lib/index.js + FFmpeg 二进制 + ffmpeg -version 可执行）。
- 注意：edit 工具写 ps1 会丢失 UTF-8 BOM，导致 PowerShell 5.1 按 GBK 解读中文报语法错误；已用 WriteAllText(UTF8Encoding($true)) 加回 BOM。verify.ps1 实测 exit 0、0 警告。
