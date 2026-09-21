/**
 * 把本机的一个 dsh 会话导出成可读转录，上传给部署的归档端。
 *
 * 这是"本地会话 → 归档成文档 → 按账号上传"的**客户端一半**。服务器那一半
 * （`plugins/dsh-archive-local`）负责落盘、用部署的模型精简、写进 Obsidian；
 * 这里只做三件客户端才有资格做的事：读本机会话、带上机器标识、用网关/归档 token 上传。
 *
 * 为什么不能直接解压会话文件：dsh 的会话日志是**每个写入批次一个独立 zstd 帧**首尾
 * 拼接的，`zstdDecompressSync` 只解得出第一帧（vault 的索引笔记里记着这个坑）。
 * 所以这里按 zstd 魔数扫出帧边界再逐帧解 —— 与 `check-session-prompt.mjs` 同一套逻辑。
 *
 * 用法（在客户端机器上，用桌面端自带的 node 或系统 node 都可以）：
 *   node export-session.mjs --latest --origin https://192.168.28.239:8443
 *   node export-session.mjs --session session-31804be7-... --dry-run
 *   node export-session.mjs --workspace deepseek-harness --out transcript.md
 */
import { readFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'

/**
 * 部署数据目录。
 *
 * 与引擎自己的规则一致：`$DSH_HOME` 优先，否则 `%USERPROFILE%\.dsh`。桌面端把
 * 本机会话写在这里，导出器必须读同一个位置。
 * @returns 绝对路径。
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh')
}

/** zstd 帧魔数；会话日志用它分帧。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 工具参数与结果各留多少字符 —— 足够看出做了什么，又不至于让转录爆掉。 */
const ARGUMENT_LIMIT = 400
const RESULT_LIMIT = 600

/** 解析命令行。 */
function parseArgs(argv) {
  const options = { withReasoning: false, dryRun: false, maxChars: 400_000 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--session') { options.session = argv[++index] }
    else if (token === '--workspace') { options.workspace = argv[++index] }
    else if (token === '--origin') { options.origin = argv[++index] }
    else if (token === '--token') { options.token = argv[++index] }
    else if (token === '--out') { options.out = argv[++index] }
    else if (token === '--max-chars') { options.maxChars = Number(argv[++index]) }
    else if (token === '--dry-run') { options.dryRun = true }
    else if (token === '--with-reasoning') { options.withReasoning = true }
    else if (token === '--latest') { options.latest = true }
    else if (token === '--pending') { options.pending = true }
    else if (token === '--help' || token === '-h') { options.help = true }
    else throw new Error(`未知参数：${token}`)
  }
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1000) {
    throw new Error('--max-chars 必须是 1000 以上的整数')
  }
  return options
}

/**
 * 解码一份会话日志的全部事件。
 * @param path - `session.v*.jsonl.zstd` 路径。
 * @returns 事件数组，按日志顺序。
 */
export function readSessionEvents(path) {
  const buffer = readFileSync(path)
  const starts = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 1)) starts.push(at)
  starts.push(buffer.length)
  const events = []
  for (let index = 0; index < starts.length - 1; index += 1) {
    try {
      const text = zstdDecompressSync(buffer.subarray(starts[index], starts[index + 1])).toString('utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try { events.push(JSON.parse(line)) } catch { /* 半行，跳过；下一帧会重新对齐 */ }
      }
    } catch {
      // 不是帧边界；按魔数扫出的下一个起点会重新同步。
    }
  }
  return events
}

/**
 * 列出本机的会话日志。
 * @param home - `$DSH_HOME`。
 * @param options - `{ session, workspace }` 过滤条件。
 * @returns `{ path, id, size, mtime }` 数组。
 */
export function listSessions(home, options = {}) {
  const root = join(home, 'sessions')
  const found = []
  let workspaces
  try {
    workspaces = readdirSync(root)
  } catch {
    return []
  }
  for (const workspaceDir of workspaces) {
    if (options.workspace !== undefined && !workspaceDir.includes(normalizeWorkspace(options.workspace))) continue
    const workspacePath = join(root, workspaceDir)
    if (!statSync(workspacePath).isDirectory()) continue
    for (const sessionDir of readdirSync(workspacePath)) {
      if (options.session !== undefined && sessionDir !== options.session) continue
      const sessionPath = join(workspacePath, sessionDir)
      if (!statSync(sessionPath).isDirectory()) continue
      for (const file of readdirSync(sessionPath)) {
        if (!/^session\.v\d+\.jsonl\.zstd$/u.test(file)) continue
        const path = join(sessionPath, file)
        const stats = statSync(path)
        found.push({ path, id: sessionDir, size: stats.size, mtime: stats.mtimeMs })
      }
    }
  }
  return found
}

/**
 * 找到本机的会话日志。
 * @param home - `$DSH_HOME`。
 * @param options - `{ session, workspace, latest }`。
 * @returns `{ path, id }`。
 * @throws 找不到、或有多个候选而没有指明哪一个。
 */
export function locateSession(home, options) {
  const found = listSessions(home, options)
  if (found.length === 0) throw new Error('在 $DSH_HOME/sessions 下找不到匹配的会话')
  if (options.session !== undefined) {
    // 同一会话可能同时留着 v2 与迁移后的 v3；取序号最高的那一份。
    return found.sort((left, right) => right.path.localeCompare(left.path))[0]
  }
  if (!options.latest) throw new Error(`匹配到 ${String(found.length)} 个会话，请用 --session 指明，或加 --latest / --pending`)
  return found.sort((left, right) => right.mtime - left.mtime)[0]
}

/** 归档台账的位置：记下每个会话上次归档时的样子。 */
export function archiveStatePath(home) {
  return join(home, 'client', 'archive-state.json')
}

/**
 * 读台账。
 *
 * 台账只回答一个问题："这个会话自上次成功归档之后有没有变过"。没有它，定时任务
 * 会把同一个会话反复上传 —— 服务器每次都要跑一次模型精简，那是真金白银。
 * @param home - `$DSH_HOME`。
 * @returns `{ [sessionId]: { size, mtime } }`；读不出来就当空的（最坏是多传一次）。
 */
export function readArchiveState(home) {
  try {
    const parsed = JSON.parse(readFileSync(archiveStatePath(home), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 记下这个会话已经归档到时的大小与时间。
 * @param home - `$DSH_HOME`。
 * @param sessionId - 会话 id。
 * @param facts - `{ size, mtime }`。
 */
export function recordArchived(home, sessionId, facts) {
  const state = readArchiveState(home)
  state[sessionId] = { size: facts.size, mtime: Math.round(facts.mtime) }
  const path = archiveStatePath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * 选出"自上次归档后有变化"的会话。
 * @param home - `$DSH_HOME`。
 * @param options - `{ workspace }` 过滤。
 * @returns 需要上传的会话，最近的排在前面。
 */
export function pendingSessions(home, options = {}) {
  const state = readArchiveState(home)
  return listSessions(home, options)
    .filter((session) => {
      const recorded = state[session.id]
      if (recorded === undefined) return true
      return recorded.size !== session.size || Math.abs((recorded.mtime ?? 0) - session.mtime) > 1000
    })
    .sort((left, right) => right.mtime - left.mtime)
}

/**
 * 把工作区名折成会话目录名里的片段。
 *
 * dsh 把工作区**路径**编码成目录名：冒号被去掉、分隔符换成 `-`，整体再用 `--`
 * 包起来。所以 `C:\Users\bestarc\Desktop\deepseek-harness` 对应目录
 * `--C-Users-bestarc-Desktop-deepseek-harness--`。这里只做同样的折叠，
 * 调用方按子串匹配；冒号如果也换成 `-`，`C--Users` 就永远匹配不上真实目录名。
 * @param workspace - 工作区名或路径。
 * @returns 用于子串匹配的片段。
 */
export function normalizeWorkspace(workspace) {
  return String(workspace).replaceAll(':', '').replaceAll(/[\\/]/gu, '-')
}

/** 取内容块里的可见文本。 */
function textOf(content, types) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && types.includes(block.type) && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** 截断长文本，保留头尾。 */
function clip(value, limit) {
  const text = String(value ?? '').trim()
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  return `${text.slice(0, head)}\n…（省略 ${String(text.length - limit)} 字）…\n${text.slice(text.length - (limit - head))}`
}

/**
 * 把事件渲染成给模型读的 Markdown 转录。
 *
 * 只保留"这次对话做了什么"需要的部分：用户说了什么、助手说了什么、调了哪些工具、
 * 结果如何。助手内部的 reasoning 默认丢掉 —— 它很长，而且结论都在可见文本里；
 * `--with-reasoning` 可以在需要时带上。
 * @param events - 会话事件。
 * @param options - `{ withReasoning }`。
 * @returns `{ markdown, meta }`。
 */
export function renderTranscript(events, options = {}) {
  const header = events.find(event => event?.type === 'session')
  const title = events.find(event => event?.type === 'session/title')?.data?.title
  const lines = []
  let turn = 0
  let lastTime = header?.createdAt ?? 0
  const calls = new Map()

  for (const event of events) {
    if (typeof event?.time === 'number') lastTime = event.time
    switch (event?.type) {
      case 'turn/start': {
        turn = event.data?.turn ?? turn + 1
        if (lines.length > 0) lines.push('')
        lines.push(`## 第 ${String(turn)} 轮`)
        break
      }
      case 'user/message': {
        // 只有 `kind: 'user'` 是这个人真的说的话。其余（`agent-instructions`、
        // `skill-catalog`、`goal`、`plugin`…）是 harness 注入的上下文：它们动辄几万字，
        // 而且复述它们会让"这次对话做了什么"被指令原文淹没。
        if (event.data?.source?.kind !== 'user') break
        const text = textOf(event.data?.content, ['text'])
        if (text !== '') lines.push('', `**用户**：${text}`)
        break
      }
      case 'assistant/message': {
        const content = event.data?.message?.content
        const text = textOf(content, ['text'])
        if (text !== '') lines.push('', `**助手**：${text}`)
        if (options.withReasoning === true) {
          const reasoning = textOf(content, ['reasoning'])
          if (reasoning !== '') lines.push('', `> 思考：${clip(reasoning, 400).replaceAll('\n', '\n> ')}`)
        }
        break
      }
      case 'tool/call': {
        const name = event.data?.name ?? 'tool'
        const callId = event.data?.callId
        if (callId !== undefined) calls.set(callId, name)
        lines.push('', `- 调用 \`${name}\`：${clip(event.data?.arguments, ARGUMENT_LIMIT).replaceAll('\n', ' ')}`)
        break
      }
      case 'tool/result': {
        const content = event.data?.message?.content
        const block = Array.isArray(content) ? content.find(item => item?.type === 'tool-result') : undefined
        const callId = block?.toolCallId
        const name = callId === undefined ? 'tool' : calls.get(callId) ?? 'tool'
        const isError = block?.isError === true
        const text = textOf(block?.content, ['text'])
        if (text !== '') lines.push(`  - \`${name}\` 返回${isError ? '（错误）' : ''}：${clip(text, RESULT_LIMIT).replaceAll('\n', ' ')}`)
        break
      }
      default: break
    }
  }

  const cwd = header?.cwd ?? ''
  return {
    markdown: lines.join('\n').trim(),
    meta: {
      sessionId: header?.id ?? '未知',
      title: typeof title === 'string' ? title : '',
      workspace: cwd,
      workspaceName: cwd === '' ? '' : basename(cwd),
      startedAt: header?.createdAt === undefined ? undefined : new Date(header.createdAt).toISOString(),
      endedAt: lastTime === 0 ? undefined : new Date(lastTime).toISOString(),
      turns: turn,
      machine: hostname(),
    },
  }
}

/**
 * 读客户端持有的归档 token。
 * @param home - `$DSH_HOME`。
 * @param explicit - 命令行给的 token。
 * @returns token。
 * @throws 没有可用 token。
 */
export function resolveArchiveToken(home, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  if (typeof process.env.HQZ_ARCHIVE_TOKEN === 'string' && process.env.HQZ_ARCHIVE_TOKEN.trim() !== '') return process.env.HQZ_ARCHIVE_TOKEN.trim()
  let text
  try {
    text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  } catch {
    throw new Error('没有归档 token：用 --token，或设 HQZ_ARCHIVE_TOKEN，或写进 $DSH_HOME/.credentials.yaml')
  }
  // 凭据文档是 YAML，但这里只需要一行 `HQZ_ARCHIVE_TOKEN: xxx`，不值得为它引一个解析器。
  const match = /^\s*HQZ_ARCHIVE_TOKEN:\s*(.+)$/mu.exec(text)
  if (match === null || match[1].trim() === '') {
    throw new Error('$DSH_HOME/.credentials.yaml 里没有 HQZ_ARCHIVE_TOKEN')
  }
  return match[1].trim().replaceAll(/^["']|["']$/gu, '')
}

/**
 * 导出转录的长度上限。
 *
 * 几小时的会话可以导出几 MB；上传它既是无谓的流量，也让服务器的"精简"退化成复述。
 * 与归档端同策略：保留头尾，中间留一句明确的省略说明。
 * @param markdown - 完整转录。
 * @param limit - 保留的最大字符数。
 * @returns 可能被裁剪的转录。
 */
export function clampTranscript(markdown, limit) {
  if (markdown.length <= limit) return markdown
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  return `${markdown.slice(0, head)}\n\n…（转录过长，中间 ${String(markdown.length - limit)} 个字符已省略）…\n\n${markdown.slice(markdown.length - tail)}`
}

/**
 * 归档端地址。
 *
 * 三层，与客户端其余配置同一套优先级：命令行给的最优先，其次环境变量，
 * 最后是 `provision-client.ps1` 写下的 `$DSH_HOME/archive.json`。
 * @param home - `$DSH_HOME`。
 * @param explicit - 命令行给的 origin。
 * @returns 归档端 origin。
 * @throws 三层都没有给出地址。
 */
export function resolveArchiveOrigin(home, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const fromEnvironment = process.env.HQZ_ARCHIVE_ORIGIN
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment.trim()
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'archive.json'), 'utf8'))
    if (typeof parsed?.origin === 'string' && parsed.origin.trim() !== '') return parsed.origin.trim()
  } catch {
    // 文件不存在或不是 JSON；下面的报错会把三层都说清楚。
  }
  throw new Error('没有归档端地址：用 --origin，或设 HQZ_ARCHIVE_ORIGIN，或先跑 provision-client.ps1')
}

const USAGE = `用法：
  node export-session.mjs --latest | --session <id> | --pending [--workspace <名>] [选项]

  --latest              导出最近更新的那个会话
  --pending             导出所有自上次归档后变化过的会话（定时任务用）
  --session <id>        指定会话 id
  --workspace <名>      只在这个工作区里找
  --origin <url>        部署地址（默认取 HQZ_ARCHIVE_ORIGIN，再取 $DSH_HOME/archive.json）
  --token <token>       归档 token（默认取 HQZ_ARCHIVE_TOKEN，再取 .credentials.yaml）
  --out <file>          只写文件不上传
  --dry-run             把转录打到标准输出
  --max-chars <n>       转录上限，默认 400000
  --with-reasoning      连助手的思考一起导出（会更长）
`

/** 入口。 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) { process.stdout.write(USAGE); return }
  if (options.pending === true) { await runPending(options); return }
  if (options.latest !== true && options.session === undefined) throw new Error(`需要 --latest、--pending 或 --session\n\n${USAGE}`)
  const home = resolveDshHome()
  const located = locateSession(home, options)
  const payload = exportOne(located, options)
  if (options.dryRun === true) { process.stdout.write(`${payload.markdown}\n`); return }
  if (options.out !== undefined) {
    writeFileSync(options.out, payload.markdown, 'utf8')
    console.log(`已写出 ${options.out}（${String(payload.markdown.length)} 字，${String(payload.turns)} 轮）`)
    return
  }
  console.log(await upload(home, options, payload))
  recordArchived(home, located.id, located)
}

/**
 * 归档"自上次之后有变化"的会话。
 *
 * 这是定时任务用的模式：一次跑完所有待归档的会话，每成功一个就记一笔台账，
 * 所以下次不会再传同一个版本。某个会话失败不影响后面的 —— 归档是尽力而为，
 * 退出码只在**一个都没成功**时才是 1，好让调度方区分"没活干"与"全挂了"。
 * @param options - 命令行选项。
 */
async function runPending(options) {
  const home = resolveDshHome()
  const pending = pendingSessions(home, options)
  if (pending.length === 0) {
    console.log(JSON.stringify({ pending: 0, archived: 0 }))
    return
  }
  let archived = 0
  const failures = []
  for (const session of pending) {
    try {
      const payload = exportOne(session, options)
      const result = await upload(home, options, payload)
      recordArchived(home, session.id, session)
      archived += 1
      console.log(JSON.stringify({ sessionId: session.id, result: JSON.parse(result) }))
    } catch (error) {
      failures.push({ sessionId: session.id, error: String(error?.message ?? error) })
    }
  }
  if (archived === 0) throw new Error(`所有 ${String(pending.length)} 个会话都归档失败：${JSON.stringify(failures)}`)
  console.log(JSON.stringify({ pending: pending.length, archived, failures }))
}

/**
 * 把一个会话读成载荷。
 * @param session - {@link listSessions} 给出的一条。
 * @param options - 命令行选项。
 * @returns 上传载荷（转录 + 元数据）。
 */
function exportOne(session, options) {
  const events = readSessionEvents(session.path)
  if (events.length === 0) throw new Error(`会话 ${session.id} 解不出任何事件：${session.path}`)
  const { markdown: full, meta } = renderTranscript(events, options)
  if (full === '') throw new Error(`会话 ${session.id} 里没有可导出的对话内容`)
  return { ...meta, markdown: clampTranscript(full, options.maxChars) }
}

/**
 * 上传一份载荷。
 * @param home - `$DSH_HOME`。
 * @param options - 命令行选项。
 * @param payload - 载荷。
 * @returns 归档端的响应文本。
 */
async function upload(home, options, payload) {
  const origin = resolveArchiveOrigin(home, options.origin)
  const token = resolveArchiveToken(home, options.token)
  const endpoint = `${origin.replace(/\/+$/u, '')}/archive/v1/sessions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`归档失败 ${String(response.status)}：${text}`)
  return text
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await main().catch((error) => {
    console.error(String(error?.message ?? error))
    process.exitCode = 1
  })
}

