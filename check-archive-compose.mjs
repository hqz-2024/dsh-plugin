/**
 * 归档笔记形状的体检：不连服务器、不调模型，只跑 `compose.js` 的纯函数。
 *
 * 为什么先验这一层：归档流水线最容易错的是**格式**（frontmatter 的键、wikilink 的
 * 写法、索引表能不能幂等替换），而不是 IO 或模型调用。而且格式不是这里定的 ——
 * vault 里已经有三篇手写样本，所以本脚本还把产出与**真实样本的骨架**对了一遍：
 * 同一组 frontmatter 键、同样的头部三行、同样以 `## 相关` 收尾。
 *
 * 用法：node check-archive-compose.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  buildSummaryPrompt, clampTranscript, indexRow, localDate, noteFilename,
  parseSummary, previousNoteName, renderNote, sanitizeTopic, upsertIndexRow,
} from './plugins/dsh-archive-local/lib/compose.js'

const failures = []
let checks = 0

/**
 * 断言一个条件。
 * @param label 这条断言在说什么。
 * @param condition 结果。
 * @param detail 失败时附上的实际值。
 */
function ok(label, condition, detail = '') {
  checks += 1
  if (!condition) failures.push(`${label}${detail === '' ? '' : ` — 实际：${detail}`}`)
}

/**
 * 断言一段代码抛错。
 * @param label 这条断言在说什么。
 * @param run 要执行的代码。
 */
function throws(label, run) {
  checks += 1
  try {
    run()
    failures.push(`${label} — 没有抛错`)
  } catch { /* 预期内 */ }
}

const archive = {
  sessionId: 'session-31804be7-088b-4ec3-b0fd-a667ea4a0d56',
  workspace: 'C:\\Users\\bestarc\\Desktop\\deepseek-harness',
  workspaceName: 'deepseek-harness',
  machine: 'DESKTOP-LCLS51R',
  startedAt: '2026-09-21T04:00:00.000Z',
  endedAt: '2026-09-21T06:30:00.000Z',
  turns: 42,
  markdown: '用户：你好\n助手：你好，有什么可以帮你？',
}

// ── 文件名安全 ───────────────────────────────────────────────────────────────

ok('主题里的 Windows 非法字符被替换', !/[<>:"/\\|?*]/u.test(sanitizeTopic('a<b>c:d"e/f\\g|h?i*j')))
ok('主题被压成单行', sanitizeTopic('  多   空格\n换行  ') === '多 空格 换行', sanitizeTopic('  多   空格\n换行  '))
ok('空主题回落而不是产出空文件名', sanitizeTopic('   ') === '会话')
ok('纯符号主题也回落', sanitizeTopic('///') === '会话')
ok('主题被截断到上限', sanitizeTopic('x'.repeat(100), 10).length === 10)
ok('wikilink 破坏字符被去掉', !sanitizeTopic('笔记[[x]]').includes('['))
ok('文件名与样本同形', noteFilename('2026-09-21', 'dsh 双模式外壳') === '2026-09-21 dsh 双模式外壳.md')

// ── 日期与裁剪 ───────────────────────────────────────────────────────────────

ok('日期取本地日', /^\d{4}-\d{2}-\d{2}$/u.test(localDate('2026-09-21T04:00:00.000Z')))
ok('坏日期回落到今天', /^\d{4}-\d{2}-\d{2}$/u.test(localDate('不是时间')))

const long = 'HEAD'.repeat(100) + 'MIDDLE'.repeat(100) + 'TAIL'.repeat(100)
const clamped = clampTranscript(long, 300)
ok('超长转录被裁剪到上限附近', clamped.length < long.length && clamped.includes('已省略'))
ok('裁剪保留开头', clamped.startsWith('HEAD'))
ok('裁剪保留结尾', clamped.endsWith('TAIL'))
ok('不超限的转录原样返回', clampTranscript('短', 300) === '短')

// ── 提示词 ───────────────────────────────────────────────────────────────────

const prompt = buildSummaryPrompt(archive)
ok('提示词带上会话 id', prompt.includes(archive.sessionId))
ok('提示词带上工作区', prompt.includes('deepseek-harness'))
ok('提示词带上转录', prompt.includes('有什么可以帮你'))
ok('缺起止时间也不炸', buildSummaryPrompt({ sessionId: 's', markdown: 'x' }).includes('时间：未知'))

// ── 摘要解析 ─────────────────────────────────────────────────────────────────

const good = parseSummary(JSON.stringify({
  topic: 'dsh 双模式外壳', overview: '总述。',
  sections: [{ title: '总览', body: '| a | b |' }],
  tags: ['dsh', '  ', 'electron'], todos: ['还要做安装器'], related: ['[[项目总览]]', 'dsh-plugin'],
}))
ok('标签去掉空白项', good.tags.length === 2, JSON.stringify(good.tags))
ok('related 去掉双方括号', good.related[0] === '项目总览', JSON.stringify(good.related))
ok('待办被保留', good.todos.length === 1)

ok('容忍模型裹代码围栏', parseSummary('```json\n' + JSON.stringify({
  topic: 't', overview: 'o', sections: [{ title: 's', body: 'b' }],
}) + '\n```').topic === 't')
throws('没有 topic 要抛', () => { parseSummary('{"overview":"o","sections":[{"title":"s"}]}') })
throws('没有 sections 要抛', () => { parseSummary('{"topic":"t","overview":"o","sections":[]}') })
throws('不是 JSON 要抛', () => { parseSummary('模型今天不想干活') })

// ── 笔记正文 ─────────────────────────────────────────────────────────────────

const date = localDate(archive.endedAt)
const topic = sanitizeTopic(good.topic)
const note = renderNote({ archive, summary: good, date, title: `${date} ${topic}`, machine: archive.machine })
const noteLines = note.split('\n')

ok('以 frontmatter 开头', noteLines[0] === '---')
ok('frontmatter 有 title/date/category', /^title: /mu.test(note) && /^date: /mu.test(note) && /^category: 会话记录$/mu.test(note))
ok('tags 里一定有 会话记录', /^tags:\n(?:  - .*\n)*  - 会话记录$/mu.test(note))
ok('正文有工作区行', note.includes('工作区：`C:\\Users\\bestarc\\Desktop\\deepseek-harness`（dsh `deepseek-harness` 工作区）'))
ok('正文有会话 id 行', note.includes(`会话 id：\`${archive.sessionId}\``))
ok('正文有时间行并带轮数', /^时间：.*（42 轮对话）$/mu.test(note))
ok('第一级标题与 frontmatter 的 title 一致', noteLines.includes(`# ${date} ${topic}`))
ok('小节自动编号', note.includes('## 一、总览'), note.slice(0, 400))
ok('待办节出现', note.includes('## 待决策') && note.includes('- [ ] 还要做安装器'))
ok('相关节收尾且链回索引', note.includes('## 相关') && note.includes('- [[会话记录索引]]'))
ok('related 渲染成 wikilink', note.includes('- [[项目总览]]') && note.includes('- [[dsh-plugin]]'))
ok('来源机器写进正文', note.includes('来源机器：`DESKTOP-LCLS51R`'))
ok('没有待办时不出现空节', !renderNote({
  archive, summary: { ...good, todos: [] }, date, title: `${date} ${topic}`, machine: '',
})?.includes('## 待决策'))
ok('三节以上继续编号', renderNote({
  archive,
  summary: { ...good, sections: [{ title: 'a', body: '' }, { title: 'b', body: '' }, { title: 'c', body: '' }] },
  date, title: 't', machine: '',
}).includes('## 三、c'))

// ── 索引行 ───────────────────────────────────────────────────────────────────

const row = indexRow({ date, sessionId: archive.sessionId, workspaceName: 'deepseek-harness', topic, noteName: `${date} ${topic}` })
ok('索引行是五列', row.split('|').length === 7, row)
ok('索引行带会话短 id', row.includes('`31804be7`'), row)
ok('索引行链到笔记', row.includes(`[[${date} ${topic}]]`), row)

const emptyIndex = upsertIndexRow('', row, archive.sessionId)
ok('空索引会新建一张表', emptyIndex.includes('| 日期 | 会话 | 工作区 | 主题 | 笔记 |') && emptyIndex.includes(row))
ok('新建索引带 frontmatter', emptyIndex.startsWith('---\n'))

const appended = upsertIndexRow(emptyIndex, indexRow({
  date: '2026-09-22', sessionId: 'session-aaaa1111-0000', workspaceName: 'w', topic: '另一件事', noteName: 'x',
}), 'session-aaaa1111-0000')
ok('新会话追加到表尾', appended.indexOf(row) < appended.indexOf('另一件事'))
ok('两行都在', appended.split('\n').filter(line => line.startsWith('| 2026')).length === 2)

const replaced = upsertIndexRow(appended, indexRow({
  date: '2026-09-23', sessionId: archive.sessionId, workspaceName: 'deepseek-harness', topic: '改过的主题', noteName: 'y',
}), archive.sessionId)
ok('同一会话是替换不是追加', replaced.split('\n').filter(line => line.includes('`31804be7`')).length === 1)
ok('替换后仍保留别的会话行', replaced.includes('另一件事'))
ok('替换后新主题生效', replaced.includes('改过的主题') && !replaced.includes(`[[${date} ${topic}]]`))

// 换名之后必须能问出旧名字，否则 vault 里会留下没有入口的孤儿笔记。
ok('能从索引问出会话当前指向的笔记名', previousNoteName(appended, archive.sessionId) === `${date} ${topic}`,
  String(previousNoteName(appended, archive.sessionId)))
ok('替换后问出的是新笔记名', previousNoteName(replaced, archive.sessionId) === 'y')
ok('索引里没有这个会话时问不出名字', previousNoteName(appended, 'session-ffffffff-0000') === undefined)
ok('空索引问不出名字', previousNoteName('', archive.sessionId) === undefined)

// ── 与 vault 里的真实样本对骨架 ──────────────────────────────────────────────

const vaultSessionDir = join(homedir(), 'obsidian笔记', '会话记录')
let samples = []
try {
  samples = readdirSync(vaultSessionDir).filter(file => file.endsWith('.md') && !file.includes('索引'))
} catch { /* vault 不在就跳过这一段，下面的报告会说明 */ }

if (samples.length === 0) {
  console.log('（跳过样本比对：vault 的会话记录目录不可读）')
} else {
  const sample = readFileSync(join(vaultSessionDir, samples[0]), 'utf8')
  const keys = (text) => (text.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '')
    .split('\n').map(line => line.split(':')[0].trim()).filter(Boolean)
  const sampleKeys = keys(sample).filter(key => !key.startsWith('-'))
  const noteKeys = keys(note).filter(key => !key.startsWith('-'))
  ok('frontmatter 的键与真实样本一致', JSON.stringify(sampleKeys) === JSON.stringify(noteKeys),
    `样本 ${JSON.stringify(sampleKeys)} vs 产出 ${JSON.stringify(noteKeys)}`)
  ok('与样本一样有工作区/会话 id/时间三行', /^工作区：/mu.test(note) && /^会话 id：/mu.test(note) && /^时间：/mu.test(note))
  ok('与样本一样以 ## 相关 收尾', note.trimEnd().endsWith(']]'))
  ok('样本用的中文序号写法一致', /^## 一、/mu.test(sample) === /^## 一、/mu.test(note), '样本或产出没有中文序号')
}

console.log(JSON.stringify({ checks, failures, samplesCompared: samples.length }, null, 2))
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} 条断言失败`)
  process.exit(1)
}
console.log(`\n归档格式干净：${String(checks)} 条断言全过（样本比对 ${String(samples.length)} 篇）。`)
