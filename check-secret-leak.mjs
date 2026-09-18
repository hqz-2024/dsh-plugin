/**
 * 检查本机真实机密有没有出现在 git 历史里 —— 尤其是**已经推到 GitHub 的那部分**。
 *
 * 两条独立证据：
 *  1. **金丝雀**：从机密各自的本地文件里把值读出来（绝不打印），拿它当字面串去搜历史。
 *     用 `git log -S`（pickaxe）找"这个串出现或消失"的提交，所以"提交过、后来又删掉"的情况
 *     一样会被抓到。
 *  2. **样式扫描**：按形状搜（`sk-…`、硬编码的 `-SmbPassword '…'`），逐提交 `git grep`，
 *     覆盖那些本地文件里已经读不到值、但历史里可能还有的情况。
 *
 * 报告分两份历史：`origin/main`（＝GitHub 上的）与"本地新增提交"（＝将来 push 才会上去的）。
 * 用法：node check-secret-leak.mjs [--canary <额外要查的值>]...
 *       脚本自身不保存任何机密值。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const repo = join(homedir(), '.dsh')
const localBranch = 'client-world'
const remoteRef = 'origin/main'

const git = (args) => {
	try {
		return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	} catch (error) {
		// `git grep` 无命中时的退出码是 1，这是"没找到"而不是失败：把它和真正的用法错误
		// （128，例如选项写错）分开，否则"干净"会被打印成一片 __ERROR__，读起来像坏了。
		if (error?.status === 1) return ''
		return `__ERROR__ ${String(error?.message ?? error)}`
	}
}
const readIf = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const firstMatch = (text, pattern) => (pattern.exec(text)?.[1] ?? '').trim()
const revs = (ref) => git(['rev-list', ref]).trim().split('\n').filter(Boolean)

const remoteRevs = revs(remoteRef)
const localRevs = revs(localBranch)
const remoteSet = new Set(remoteRevs)
const localOnlyRevs = localRevs.filter((rev) => !remoteSet.has(rev))

/** 金丝雀：值从各自文件里读，读不到就跳过。 */
const canaries = []
const push = (label, value) => {
	if (typeof value === 'string' && value.length >= 8) canaries.push({ label, value })
}
const creds = readIf(join(repo, '.credentials.yaml'))
push('AI API key（.credentials.yaml）', firstMatch(creds, /(sk-[A-Za-z0-9_-]{16,})/))
const webClient = readIf(join(repo, 'profiles', 'web-client', 'cordis.patch.yml'))
push('machineSecret（部署级机器密钥）', firstMatch(webClient, /machineSecret:\s*'([^']+)'/))
push('relayTokens 密钥', firstMatch(webClient, /relayTokens:\s*\n\s*([0-9a-f]{16,}):/))
push('sidecar token（web profile）', firstMatch(readIf(join(repo, 'profiles', 'web', 'cordis.patch.yml')), /token:\s*'?([A-Za-z0-9_-]{24,})'?/))
for (const extra of process.argv.slice(2)) {
	if (process.argv[process.argv.indexOf(extra) - 1] === '--canary') push('命令行传入', extra)
}

/** 逐提交按样式搜文件（不用一次性传上百个 rev，避免命令行长度问题）。 */
const grepAcross = (pattern, list) => {
	const hits = []
	for (const rev of list) {
		// `-e` 是必须的：模式可能以 `-` 开头（例如 `-SmbPassword`），
		// 直接当位置参数传会被 git 当成选项，报 "unknown switch" 并静默变成"没命中"。
		const out = git(['grep', '-l', '-I', '-E', '-e', pattern, rev])
		if (out.startsWith('__ERROR__')) {
			hits.push(`__ERROR__ ${rev}`)
			continue
		}
		if (out.trim() === '') continue
		for (const line of out.trim().split('\n')) hits.push(line)
	}
	return hits
}
/** pickaxe：这个串在这份历史里出现过或消失过的提交。 */
const pickaxe = (value, ref, extra = []) =>
	git(['log', '--oneline', ...extra, '-S', value, ref]).trim().split('\n').filter(Boolean)

const report = { remoteRef, remoteCommits: remoteRevs.length, localBranch, localOnlyCommits: localOnlyRevs.length, canaries: [], patterns: [] }

for (const { label, value } of canaries) {
	report.canaries.push({
		label,
		length: value.length,
		在GitHub历史里: pickaxe(value, remoteRef).length,
		在本地新增提交里: pickaxe(value, localBranch, ['--not', remoteRef]).length,
	})
}

for (const [label, pattern] of [
	['OpenAI/DeepSeek 风格密钥 sk-…', 'sk-[A-Za-z0-9]{16,}'],
	["setup-smb.ps1 参数默认值里的真密码", "\\[string\\]\\$SmbPassword[[:space:]]*=[[:space:]]*'[^']{6,}'"],
]) {
	// `git grep -l <rev>` 的输出是 `<rev>:<path>`，所以"命中提交数"就从这里数，
	// 不再另跑一遍 pickaxe：两套口径不一致时，读者没法判断哪个才算数。
	const filesOf = (list) => [...new Set(list.filter((line) => !line.startsWith('__ERROR__')).map((line) => line.slice(line.indexOf(':') + 1)))]
	const revsOf = (list) => new Set(list.filter((line) => !line.startsWith('__ERROR__')).map((line) => line.slice(0, line.indexOf(':')))).size
	const remoteFiles = grepAcross(pattern, remoteRevs)
	const localFiles = grepAcross(pattern, localOnlyRevs)
	report.patterns.push({
		label,
		在GitHub历史里命中提交数: revsOf(remoteFiles),
		在GitHub历史里命中文件: filesOf(remoteFiles).slice(0, 6),
		在本地新增提交里命中提交数: revsOf(localFiles),
		在本地新增提交里命中文件: filesOf(localFiles).slice(0, 6),
	})
}

console.log(JSON.stringify(report, null, 2))
console.log(
	'\n判读：金丝雀的 0 表示"这份历史里从未出现过该值"；样式扫描的 0 表示"没有任何提交含该形状"。'
	+ '\n"本地新增提交"一旦 push 就会变成 GitHub 历史，而历史里的内容删不掉。',
)
