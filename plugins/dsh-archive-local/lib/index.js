/**
 * 会话归档的接收端：把客户端导出的对话存下来，用部署的模型精简，写进 Obsidian 库。
 *
 * 为什么在服务器上做：客户端（桌面端本地模式）没有、也不该有 vault 的位置与模型凭据，
 * 而"精简"要用部署自己的模型路由。客户端只负责导出与上传，其余全在这里。
 *
 * 三个动作，顺序固定：
 *  1. **先落原文**。模型调用可能失败、可能超时；转录一旦到手就先写进 `storeDir`，
 *     所以精简失败不会丢掉这次归档，重试也不必再麻烦客户端。
 *  2. **精简**。`ctx.llm.stream()` 走部署自己的路由（与网关同一份凭据），要求模型
 *     只回一个 JSON 对象；形状不对就退化成"只存原文"，并把这个事实写进响应。
 *  3. **写进 vault**。笔记文件与索引行都由 `compose.js` 的纯函数算出，形状与 vault 里
 *     已有的手写样本一致；同一会话反复归档是替换而不是追加。
 *
 * vault 是用户自己的 git 工作树，所以写入范围由配置收窄到"一个会话目录 + 一个索引
 * 文件"，且不碰其他任何文件。
 * @module dsh-archive-local
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  buildSummaryPrompt,
  clampTranscript,
  indexRow,
  localDate,
  noteFilename,
  parseSummary,
  previousNoteName,
  renderNote,
  sanitizeTopic,
  SUMMARY_INSTRUCTIONS,
  upsertIndexRow,
} from './compose.js'

/** Cordis 插件名。 */
export const name = 'dsh-archive'

/** 本行需要 HTTP 服务面与模型路由。 */
export const inject = ['webServer', 'llm']

/** 单次请求体的默认上限（1 MiB 的文本足够容纳很长的转录）。 */
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024

/** 归档记录允许携带的字段；其余一律丢弃，避免把客户端的任意键写进日志或笔记。 */
const TEXT_FIELDS = ['machine', 'workspace', 'workspaceName', 'sessionId', 'title', 'startedAt', 'endedAt']

/**
 * 读配置并校验。
 *
 * 路径类配置必须能落盘，凭据必须成对出现；缺一项就抛，让挂载时大声失败 ——
 * 一个"看起来挂上了但写不出笔记"的归档端比没有归档端更难查。
 * @param config - 行配置。
 * @returns 规范化后的设置。
 */
function resolveSettings(config) {
  const path = typeof config?.path === 'string' && config.path.startsWith('/') ? config.path.replace(/\/+$/u, '') : ''
  if (path === '') throw new Error('archive: config.path must be an absolute path such as /archive')
  const vaultDir = typeof config?.vaultDir === 'string' && config.vaultDir.trim() !== '' ? resolve(config.vaultDir) : ''
  if (vaultDir === '') throw new Error('archive: config.vaultDir must name the Obsidian vault directory')
  const sessionDir = typeof config?.sessionDir === 'string' && config.sessionDir.trim() !== '' ? config.sessionDir.trim() : '会话记录'
  const indexFile = typeof config?.indexFile === 'string' && config.indexFile.trim() !== '' ? config.indexFile.trim() : '会话记录索引.md'
  const storeDir = typeof config?.storeDir === 'string' && config.storeDir.trim() !== '' ? resolve(config.storeDir) : ''
  if (storeDir === '') throw new Error('archive: config.storeDir must name the directory that keeps raw transcripts')
  const provider = typeof config?.provider === 'string' && config.provider.trim() !== '' ? config.provider.trim() : ''
  const model = typeof config?.model === 'string' && config.model.trim() !== '' ? config.model.trim() : ''
  if (provider === '' || model === '') throw new Error('archive: config.provider and config.model must name the summarization route')
  const tokens = new Map()
  for (const [token, account] of Object.entries(config?.tokens ?? {})) {
    if (typeof account !== 'string' || account.trim() === '') throw new Error(`archive: token for ${token.slice(0, 4)}… has no account`)
    tokens.set(token, account.trim())
  }
  const maxTranscriptChars = Number.isSafeInteger(config?.maxTranscriptChars) && config.maxTranscriptChars > 0
    ? config.maxTranscriptChars
    : 400_000
  const maxRequestBytes = Number.isSafeInteger(config?.maxRequestBytes) && config.maxRequestBytes > 0
    ? config.maxRequestBytes
    : DEFAULT_MAX_REQUEST_BYTES
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 180_000
  const logPath = typeof config?.logPath === 'string' && config.logPath.trim() !== '' ? resolve(config.logPath) : ''
  return { path, vaultDir, sessionDir, indexFile, storeDir, provider, model, tokens, maxTranscriptChars, maxRequestBytes, timeoutMs, logPath }
}

/** 读请求体，超过上限就中止；返回 `undefined` 表示已经应答过。 */
async function readBody(req, res, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'archive body is larger than maxRequestBytes' }))
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 统一的 JSON 应答。 */
function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * 校验并规范化一条归档。
 * @param input - 解析后的请求体。
 * @returns 归档记录。
 * @throws 缺少会话 id 或转录。
 */
function readArchive(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('archive body must be a JSON object')
  const archive = {}
  for (const field of TEXT_FIELDS) {
    if (typeof input[field] === 'string' && input[field].trim() !== '') archive[field] = input[field].trim()
  }
  if (archive.sessionId === undefined) throw new Error('archive body must carry sessionId')
  if (typeof input.markdown !== 'string' || input.markdown.trim() === '') throw new Error('archive body must carry markdown')
  archive.markdown = input.markdown
  if (Number.isFinite(input.turns)) archive.turns = input.turns
  return archive
}

/**
 * 判断一次流式调用是否以失败收场，并把提供方的原话带出来。
 *
 * `FinishReason` 是**对象**（`{ kind: 'error', failure }`）而不是字符串 —— 直接和
 * `'error'` 比较永远不成立，于是"没有密钥""上游 401"这类失败会被吞成
 * "模型没吐 JSON"，把排查方向指错。
 * @param reason - `finish` 块里的 reason。
 * @returns 失败说明，正常结束返回 undefined。
 */
function finishFailure(reason) {
  if (reason === null || typeof reason !== 'object') return undefined
  if (reason.kind === 'error') return `模型调用失败：${reason.failure?.message ?? '未提供原因'}`
  if (reason.kind === 'aborted') return `模型调用被中止：${reason.failure?.message ?? '未提供原因'}`
  return undefined
}

/**
 * 调用部署的模型路由，把转录精简成结构化摘要。
 * @param ctx - 插件上下文。
 * @param settings - 归档端设置。
 * @param archive - 归档记录。
 * @returns 解析后的摘要。
 */
async function summarize(ctx, settings, archive) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error(`archive: summarization exceeded ${String(settings.timeoutMs)} ms`)) }, settings.timeoutMs)
  try {
    const options = {
      provider: settings.provider,
      model: settings.model,
      system: SUMMARY_INSTRUCTIONS,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildSummaryPrompt(archive) }] }],
      signal: controller.signal,
    }
    let text = ''
    for await (const chunk of ctx.llm.stream(options)) {
      // 只累加可见文本：推理增量与工具调用不属于笔记内容。
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') {
        const failure = finishFailure(chunk.reason)
        if (failure !== undefined) throw new Error(`archive: ${failure}`)
      }
    }
    if (text.trim() === '') throw new Error('archive: 模型没有返回任何文本')
    return parseSummary(text)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 落盘：原文、笔记、索引。
 * @param settings - 归档端设置。
 * @param account - 令牌对应的账号。
 * @param archive - 归档记录。
 * @param summary - 摘要；`undefined` 表示只存原文。
 * @returns 写入结果的描述，供响应与日志使用。
 */
function store(settings, account, archive, summary) {
  const date = localDate(archive.endedAt ?? archive.startedAt)
  const rawDir = join(settings.storeDir, account)
  mkdirSync(rawDir, { recursive: true })
  const rawFile = join(rawDir, `${date}-${archive.sessionId}.md`)
  const provenance = [
    '---',
    `account: ${account}`,
    `sessionId: ${archive.sessionId}`,
    `workspace: ${archive.workspace ?? ''}`,
    `machine: ${archive.machine ?? ''}`,
    `startedAt: ${archive.startedAt ?? ''}`,
    `endedAt: ${archive.endedAt ?? ''}`,
    '---',
    '',
  ].join('\n')
  writeFileSync(rawFile, `${provenance}${archive.markdown}`, 'utf8')
  if (summary === undefined) return { rawFile, noteFile: undefined, indexFile: undefined, topic: undefined }

  const topic = sanitizeTopic(summary.topic)
  const noteName = noteFilename(date, topic).replace(/\.md$/u, '')
  const title = `${date} ${topic}`
  const noteFile = join(settings.vaultDir, settings.sessionDir, `${noteName}.md`)
  mkdirSync(dirname(noteFile), { recursive: true })
  writeFileSync(noteFile, renderNote({ archive, summary, date, title, machine: archive.machine }), 'utf8')

  const indexPath = join(settings.vaultDir, settings.sessionDir, settings.indexFile)
  const indexText = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : ''
  // 同一会话换了主题就会换文件名；索引是"哪个文件代表这个会话"的唯一记录，
  // 先问出旧名字，写完新行再把旧文件删掉，否则 vault 里会留下孤儿笔记。
  const staleName = previousNoteName(indexText, archive.sessionId)
  const row = indexRow({
    date, sessionId: archive.sessionId, workspaceName: archive.workspaceName ?? '', topic, noteName,
  })
  writeFileSync(indexPath, upsertIndexRow(indexText, row, archive.sessionId), 'utf8')
  let removedNote
  if (staleName !== undefined && staleName !== noteName) {
    // 只删会话目录里、由索引亲自指过的那个文件；绝不按推测的路径删东西。
    const stale = join(settings.vaultDir, settings.sessionDir, `${staleName}.md`)
    if (existsSync(stale)) {
      rmSync(stale)
      removedNote = stale
    }
  }
  return { rawFile, noteFile, indexFile: indexPath, topic, ...(removedNote === undefined ? {} : { removedNote }) }
}

/**
 * 挂载归档端。
 * @param ctx - 插件上下文（宿主平面：它注册 HTTP 路由，不是每会话能力）。
 * @param config - 行配置，见 `cordis.patch.yml`。
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const log = (entry) => {
    if (settings.logPath === '') return
    try {
      appendFileSync(settings.logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    } catch (error) {
      // 记账失败不该让一次已经落盘的归档变成 5xx；日志是诊断，不是事实来源。
      ctx.logger?.warn?.(`[archive] 无法写入日志：${String(error)}`)
    }
  }

  /** `POST <path>/v1/sessions` —— 认证、落原文、精简、写 vault。 */
  const onSessions = async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: 'use POST for session archives' }); return }
    const header = String(req.headers.authorization ?? '')
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const account = token === '' ? undefined : settings.tokens.get(token)
    if (account === undefined) { respond(res, 401, { error: 'unknown archive token' }); return }
    const body = await readBody(req, res, settings.maxRequestBytes)
    if (body === undefined) return
    let archive
    try {
      archive = readArchive(JSON.parse(body))
    } catch (error) {
      respond(res, 400, { error: String(error?.message ?? error) })
      return
    }
    archive.markdown = clampTranscript(archive.markdown, settings.maxTranscriptChars)
    let summary
    let summaryFailure
    try {
      summary = await summarize(ctx, settings, archive)
    } catch (error) {
      // 精简失败仍然算归档成功：原文已经拿到手，把失败原因如实回给客户端。
      summaryFailure = String(error?.message ?? error)
    }
    let stored
    try {
      stored = store(settings, account, archive, summary)
    } catch (error) {
      respond(res, 500, { error: `archive could not be stored: ${String(error?.message ?? error)}` })
      return
    }
    log({
      account,
      sessionId: archive.sessionId,
      machine: archive.machine ?? '',
      transcriptChars: archive.markdown.length,
      summarized: summary !== undefined,
      ...(summaryFailure === undefined ? {} : { summaryFailure }),
      topic: stored.topic ?? '',
    })
    respond(res, 200, {
      account,
      sessionId: archive.sessionId,
      stored: stored.rawFile,
      summarized: summary !== undefined,
      ...(summaryFailure === undefined ? {} : { summaryFailure }),
      ...(stored.noteFile === undefined ? {} : { note: stored.noteFile, index: stored.indexFile }),
      ...(stored.removedNote === undefined ? {} : { removedNote: stored.removedNote }),
    })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${settings.path}/v1/sessions`, handler: onSessions }),
    'archive: sessions route')
  ctx.logger?.info?.(`[archive] ${settings.path}/v1/sessions -> ${settings.vaultDir}（精简走 ${settings.provider}/${settings.model}）`)
}
