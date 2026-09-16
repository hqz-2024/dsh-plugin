---
name: local-staging
description: 当工作区已绑定到用户电脑、需要在用户本机的软件（Photoshop/Blender/Office 等）里处理大文件时，用本机暂存目录做签出/回写，避免重软件直接在网络共享上工作。触发条件：提示词里出现「Where your commands run」段、要处理 .psd/.blend/大素材、或用户说"用我电脑上的 PS/Blender 处理这个"。
---

# 本机暂存工作流

## 什么时候用

**只在工作区已绑定到用户电脑时适用。** 判据：系统提示词里有 `Where your commands run` 段。没有那段 = 命令跑在服务器上，文件本来就在服务器本地盘，不存在这个问题，直接干活。

绑定状态下，用本机软件（Photoshop / Blender / Office / 剪辑软件）**处理大于约 10MB 的文件或工程格式**时，走这套流程。

## 为什么要这么做

工作区文件只有一份，在服务器上，通过 SMB 共享给用户电脑。**Adobe 官方只支持在本地硬盘上使用 Photoshop**，明确不支持把网络位置作为暂存盘；Blender 在 SMB 上读写外部资源有已知的严重 I/O 问题。直连共享干活可能间歇性报 `file is locked` / `disk error` / `unknown format`，而且**损坏可能延迟出现、无法察觉**。

暂存目录是**临时工作副本**，不是第二份同步。服务器工作区仍是唯一权威。

## 流程

提示词里的路径对照会给出两个位置：

- 工作区（服务器路径）—— `read` / `write` / `edit` / `glob` / `grep` 用它
- 工作区（用户电脑可见路径，通常是 UNC）—— **shell 命令里的路径必须用这个**
- 本机暂存目录 —— 形如 `C:\dsh-staging`

### 1. 判定

用 `read` 工具的 size，或 `glob`。**满足任一条就走暂存**：

- 文件 > 10MB
- 工程格式：`.psd` / `.psb` / `.blend` / `.ai` / `.indd` / 视频素材 / 大音频
- 用户明确说"用我电脑上的 XX 打开"

不满足（文本、普通 Office、PDF）→ **直接在共享上打开**，别多此一举。

### 2. 签出（复制到本机暂存目录）

用 shell 命令，**路径用可见路径**：

```powershell
$src = "<工作区可见路径>\子目录\文件.psd"
$dst = "<本机暂存目录>\文件.psd"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
Copy-Item -LiteralPath $src -Destination $dst -Force
Get-Item $dst | Select-Object FullName, Length
```

**大目录用 robocopy**（比 Copy-Item 稳，能续传）：

```powershell
robocopy "<可见路径>\素材" "<暂存目录>\素材" /E /R:2 /W:2 /NP
```

### 3. 处理

在**暂存副本**上操作，**永远不要碰共享路径**：

- Photoshop：COM / ExtendScript，打开 `$dst`
- Blender：`blender -b "<暂存>\场景.blend" -P 脚本.py`
- 其他软件：用它的 CLI 或脚本接口

先用 `Get-Command` / `Test-Path` 确认软件在本机存在；**没有就明确告诉用户缺什么**，不要假装成功。

### 4. 回写

处理完，把结果复制回工作区（可见路径）：

```powershell
Copy-Item -LiteralPath $dst -Destination $src -Force
```

回写后用 `read` 工具从**服务器路径**确认文件确实更新了（大小/时间戳）。这一步是验收，别省。

### 5. 清理

```powershell
Remove-Item -LiteralPath $dst -Force
```

**任务结束就清理**，不要留着占空间。

## 残留处理

如果发现暂存目录里有**上次没回写的文件**（任务开始时目录非空）：

1. **先问用户**要不要保留，不要直接删
2. 如果是本次要用的文件，说明它可能是上次的中间结果，确认后再决定覆盖还是改名

**用户那边也会被告知**：executor 在**每次绑定工作区时**会扫一遍暂存目录，有残留就在自己的日志和本机配置页上列出来（只列不删）。所以你看到残留时，用户很可能已经看到过同样的提示 —— 先问他上次那批文件还要不要，而不是直接覆盖或删除。这两处是同一个判断，不要当成两件事。

## 铁律

1. **大文件绝不直接在共享上打开** —— 这是本流程存在的唯一理由
2. **shell 命令里只用可见路径**；服务器路径在用户电脑上不存在
3. **回写后必须验证**（大小/时间戳），不能只看命令返回码
4. **软件不存在要明说**，不要静默降级或伪造结果
5. 有副作用的命令（删除、覆盖）先确认
