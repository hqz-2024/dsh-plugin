/**
 * 归档笔记的形状：提示词、文件名、正文与索引行。
 *
 * 这个模块只做**纯函数**：给定一份归档与模型给出的结构化摘要，算出要写进 vault 的
 * 字节。写盘与模型调用在 `index.js`，所以这一层可以直接被脚本喂样例验证 —— 归档
 * 流水线最容易错的地方是格式（frontmatter、wikilink、索引表的行），而不是 IO。
 *
 * 目标形状**不是这里发明的**：`C:\Users\bestarc\obsidian笔记\会话记录\` 里已有三篇
 * 手工样本和一个索引，本模块产出与它们同形的结果。
 * @module dsh-archive-local/compose
 */

/** 索引里每一行都带这个标记，用来按会话 id 幂等替换。 */
export const SESSION_TAG = '会话记录'

/** 中文序号，最多支持到二十；超出的节不再编号。 */
const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

/**
 * 把一段文字压成可以安全落成文件名的主题。
 *
 * Windows 文件名不允许 `< > : " / \ | ? *`，控制字符与结尾的点/空格同样会出问题；
 * 主题还会被嵌进 Markdown 链接，所以方括号也要去掉。空结果回落到"会话"——
 * 宁可文件名平庸，也不要因为模型给了一个纯符号的主题而写不出文件。
 * @param value - 模型给出的主题。
 * @param limit - 主题的最大字符数。
 * @returns 可安全用于文件名与 wikilink 的主题。
 */
export function sanitizeTopic(value, limit = 40) {
  const cleaned = String(value ?? '')
    .replaceAll(/[<>:"/\\|?*[\]#^]/gu, ' ')
    .replaceAll(/[\u0000-\u001f\u007f]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .replaceAll(/[. ]+$/gu, '')
  const capped = cleaned.length > limit ? cleaned.slice(0, limit).trim() : cleaned
  return capped === '' ? '会话' : capped
}

/**
 * 笔记的文件名（不含目录）。
 * @param date - `YYYY-MM-DD`。
 * @param topic - 已净化的主题。
 * @returns `YYYY-MM-DD 主题.md`，与样本目录里的命名一致。
 */
export function noteFilename(date, topic) {
  return `${date} ${sanitizeTopic(topic)}.md`
}

/** 把 `YYYY-MM-DD` 渲染成 `YYYY年M月D日`，用于标题里的人类可读日期。 */
function humanDate(date) {
  const [year, month, day] = date.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

/** 把 ISO 时间截成 `YYYY-MM-DD HH:mm`；无法解析时原样返回。 */
function shortTime(value) {
  if (typeof value !== 'string' || value === '') return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  const pad = (number) => String(number).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 从 ISO 时间取 `YYYY-MM-DD`（本地时区）；不可解析时回落到今天。 */
export function localDate(value, fallback = new Date()) {
  const at = typeof value === 'string' && value !== '' ? new Date(value) : fallback
  const usable = Number.isNaN(at.getTime()) ? fallback : at
  const pad = (number) => String(number).padStart(2, '0')
  return `${String(usable.getFullYear())}-${pad(usable.getMonth() + 1)}-${pad(usable.getDate())}`
}

/**
 * 归档正文的长度上限。
 *
 * 一次几小时的会话可以把导出正文推到几 MB；模型窗口吃得下，但把整个转录原样塞进
 * 请求既贵又会让"精简"退化成"复述"。超限时保留头尾：开头定基调，结尾通常带着结论。
 * @param markdown - 客户端导出的转录。
 * @param limit - 保留的最大字符数。
 * @returns 可能被裁剪的转录，裁剪处留明确标记。
 */
export function clampTranscript(markdown, limit) {
  const text = String(markdown ?? '')
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  return `${text.slice(0, head)}\n\n…（转录过长，中间 ${String(text.length - limit)} 个字符已省略）…\n\n${text.slice(text.length - tail)}`
}

/** 提示词里对模型的要求；与 `SUMMARY_SCHEMA` 一一对应。 */
export const SUMMARY_INSTRUCTIONS = `你在为一份 dsh（DeepSeek Harness）对话写归档笔记。

只输出一个 JSON 对象，不要 Markdown 代码围栏，不要解释。字段：

{
  "topic": "4-12 个字的主题，会进文件名，不要标点与斜杠",
  "overview": "一到两段总述这次对话做了什么，从身份与目标写起",
  "sections": [
    { "title": "小节标题（不要写序号）", "body": "这一节的 Markdown 正文" }
  ],
  "tags": ["除\"会话记录\"之外的主题标签，2-6 个，小写英文或中文短语"],
  "todos": ["仍未决定或待办的事项，没有就给空数组"],
  "related": ["相关笔记名，不含双方括号，没有就给空数组"]
}

写作要求：
- **按事情发生的顺序**组织 sections，一节一件事，标题具体（例如"引擎仓库：脏合并提交的处理"，不要"工作过程"）。
- 正文优先用表格与短句：做了什么、改了什么、结果如何。踩过的坑单独成节。
- 只写转录里真实出现的事实与路径；不要把推测写成结论，也不要编造提交号或数字。
- 转录里的工具输出可能很长，只提炼结论。
- 用中文。`

/**
 * 组装发给模型的提示词。
 * @param archive - 归档元数据与转录。
 * @returns 一条用户消息的文本。
 */
export function buildSummaryPrompt(archive) {
  const started = shortTime(archive.startedAt)
  const ended = shortTime(archive.endedAt)
  const window = started === '' ? '未知' : ended === '' ? started : `${started} ~ ${ended}`
  const header = [
    `会话 id：${String(archive.sessionId ?? '未知')}`,
    `工作区：${String(archive.workspace ?? '未知')}`,
    `机器：${String(archive.machine ?? '未知')}`,
    `时间：${window}`,
    `轮数：${String(archive.turns ?? '未知')}`,
    '',
    '以下是这次对话的导出转录：',
    '',
  ].join('\n')
  return `${header}${String(archive.markdown ?? '')}`
}

/**
 * 把模型返回的文本解析成摘要对象。
 *
 * 模型偶尔会裹上代码围栏或前后加话，所以先截取第一个 `{` 到最后一个 `}`；
 * 解析失败或字段缺失都抛错，由调用方决定是否回落到"只存原文"。
 * @param text - 模型输出。
 * @returns 规范化后的摘要。
 * @throws 输出不是可用 JSON，或缺少必需的字符串字段。
 */
export function parseSummary(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('archive: summary is not a JSON object')
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    throw new Error(`archive: summary is not valid JSON: ${String(error)}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('archive: summary must be a JSON object')
  }
  const strings = (value) => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim()) : [])
  const sections = Array.isArray(parsed.sections)
    ? parsed.sections
      .filter(section => typeof section === 'object' && section !== null && typeof section.title === 'string' && String(section.title).trim() !== '')
      .map(section => ({ title: String(section.title).trim(), body: String(section.body ?? '').trim() }))
    : []
  if (typeof parsed.topic !== 'string' || parsed.topic.trim() === '') throw new Error('archive: summary has no topic')
  if (typeof parsed.overview !== 'string' || parsed.overview.trim() === '') throw new Error('archive: summary has no overview')
  if (sections.length === 0) throw new Error('archive: summary has no sections')
  return {
    topic: parsed.topic.trim(),
    overview: parsed.overview.trim(),
    sections,
    tags: strings(parsed.tags),
    todos: strings(parsed.todos),
    related: strings(parsed.related).map(name => name.replaceAll(/^\[\[|\]\]$/gu, '').trim()).filter(name => name !== ''),
  }
}

/**
 * 渲染最终笔记。
 * @param options.archive - 归档元数据（工作区、会话 id、起止时间、轮数）。
 * @param options.summary - 解析后的摘要。
 * @param options.date - 笔记日期 `YYYY-MM-DD`。
 * @param options.title - 笔记标题（`日期 主题`）。
 * @param options.machine - 上传这台机器的标识，写进正文便于追溯。
 * @returns 完整 Markdown 文本（含 frontmatter）。
 */
export function renderNote({ archive, summary, date, title, machine }) {
  const started = shortTime(archive.startedAt)
  const ended = shortTime(archive.endedAt)
  const window = started === '' ? date : ended === '' || ended === started ? started : `${started} ~ ${ended}`
  const turns = typeof archive.turns === 'number' && Number.isFinite(archive.turns) ? `${String(archive.turns)} 轮对话` : ''
  const timeLine = turns === '' ? window : `${window}（${turns}）`
  const workspace = String(archive.workspace ?? '未知')
  const workspaceName = String(archive.workspaceName ?? '').trim()

  const tags = [...new Set([SESSION_TAG, ...summary.tags])]
  const lines = [
    '---',
    `title: ${title}`,
    `date: ${date}`,
    'tags:',
    ...tags.map(tag => `  - ${tag}`),
    `category: ${SESSION_TAG}`,
    '---',
    '',
    `# ${title}`,
    '',
    `工作区：\`${workspace}\`${workspaceName === '' ? '' : `（dsh \`${workspaceName}\` 工作区）`}`,
    `会话 id：\`${String(archive.sessionId ?? '未知')}\``,
    `时间：${timeLine}`,
    ...(machine === undefined || machine === '' ? [] : [`来源机器：\`${machine}\``]),
    '',
    summary.overview,
    '',
  ]
  summary.sections.forEach((section, index) => {
    const numeral = CHINESE_NUMERALS[index]
    lines.push(numeral === undefined ? `## ${section.title}` : `## ${numeral}、${section.title}`, '', section.body, '')
  })
  if (summary.todos.length > 0) {
    lines.push('## 待决策', '', ...summary.todos.map(todo => `- [ ] ${todo}`), '')
  }
  lines.push(
    '## 相关',
    '',
    `- [[会话记录索引]] — 所有对话总结的入口`,
    ...summary.related.map(name => `- [[${name}]]`),
    '',
  )
  return lines.join('\n')
}

/**
 * 索引表里的一行。
 * @param options.date - `YYYY-MM-DD`；跨天会话由调用方给出 `起 ~ 止`。
 * @param options.sessionId - 会话 id，幂等替换的依据。
 * @param options.workspaceName - 工作区显示名。
 * @param options.topic - 主题。
 * @param options.noteName - 笔记文件名（不含 `.md`），wikilink 指向它。
 * @returns 一行 Markdown 表格行。
 */
export function indexRow({ date, sessionId, workspaceName, topic, noteName }) {
  const short = String(sessionId ?? '').replace(/^session-/u, '').split('-')[0]
  return `| ${date} | \`${short === '' ? String(sessionId ?? '') : short}\` | ${workspaceName === '' ? '—' : workspaceName} | ${topic} | [[${noteName}]] |`
}

/** 索引文件的表头；插入新行时用它定位表格。 */
const INDEX_HEADER = ['| 日期 | 会话 | 工作区 | 主题 | 笔记 |', '| --- | --- | --- | --- | --- |']

/**
 * 索引里这个会话当前指向的笔记名（不含 `.md`）。
 *
 * 同一个会话可以反复归档，而模型每次给出的主题可能不同 —— 于是笔记文件名也会变。
 * 索引是"哪个文件代表这个会话"的唯一记录，所以换名之前必须先问它旧名字是什么，
 * 否则 vault 里会留下一个没有任何入口的孤儿笔记。
 * @param text - 索引文件现有内容。
 * @param sessionId - 会话 id。
 * @returns 旧笔记名，没有对应行时 undefined。
 */
export function previousNoteName(text, sessionId) {
  const short = String(sessionId ?? '').replace(/^session-/u, '').split('-')[0]
  if (short === '') return undefined
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('|') || !line.includes(`\`${short}\``)) continue
    const link = /\[\[([^\]]+)\]\]/u.exec(line)
    if (link !== null) return link[1].trim()
  }
  return undefined
}

/**
 * 把一行插进索引，按会话 id 幂等。
 *
 * 已有同一会话的行会被替换而不是追加：会话可以在几天里反复归档，索引里堆出多行
 * 同一个 id 会让人以为存在多个会话。替换保留原位置，追加放到表尾。
 * @param text - 索引文件现有内容；为空则生成一个新索引。
 * @param row - {@link indexRow} 产出的表格行。
 * @param sessionId - 用来识别既有行的会话 id。
 * @returns 新的索引文本。
 */
export function upsertIndexRow(text, row, sessionId) {
  const short = String(sessionId ?? '').replace(/^session-/u, '').split('-')[0]
  const lines = String(text ?? '').split('\n')
  const existing = lines.findIndex(line => short !== '' && line.startsWith('|') && line.includes(`\`${short}\``))
  if (existing >= 0) {
    lines[existing] = row
    return lines.join('\n')
  }
  const separator = lines.findIndex(line => /^\|\s*---/u.test(line))
  if (separator >= 0) {
    // 追加到**表的末尾**，不是分隔行后面：vault 里已有的索引按日期升序排列，
    // 插在表头下面会让新记录跑到最旧的一条前面。
    let last = separator
    while (last + 1 < lines.length && lines[last + 1].startsWith('|')) last += 1
    lines.splice(last + 1, 0, row)
    return lines.join('\n')
  }
  // 没有索引文件（或它不是一张表）：写一份新的，形状与样本一致。
  return [
    '---',
    'title: 会话记录索引',
    'tags:',
    '  - index',
    `  - ${SESSION_TAG}`,
    `category: ${SESSION_TAG}`,
    '---',
    '',
    '# 会话记录索引',
    '',
    '这里存放 dsh 对话的归档总结。每条记录对应 dsh 里真实存在的一个会话。',
    '',
    '## 已有记录',
    '',
    ...INDEX_HEADER,
    row,
    '',
  ].join('\n')
}
