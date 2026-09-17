/**
 * Build `dsh-executor.exe` — the client executor as one self-contained Windows
 * executable (plan §2.5: "先做成 Node + 本地配置页 + 开机自启，稳定后再打包 exe").
 *
 * Why SEA and not Electron/Tauri: the executable is a *headless* client. Its user
 * interface is the local configuration page it already serves, so what an `.exe`
 * buys is exactly three things — no Node install on the client machine, a program
 * the user can double-click, and room for a tray icon and an update channel later.
 *
 * What SEA here can and cannot do (measured on Node 22.22.3, not assumed):
 *   ✘ the embedded script is run as COMMONJS, whatever its extension says — an ESM
 *     entry dies at load with "Cannot use import statement outside a module". (A
 *     first probe "passed" only because that test file happened to contain no import
 *     statements at all.) So the executor is bundled to CJS before packing;
 *   ✔ dynamic `import()` of a builtin works;
 *   ✘ dynamic `import()` of a FILE on disk fails — which is why the executor loads
 *     its optional node-pty through `createRequire` instead;
 *   ✘ a top-level `await` in the entry fails at load time (the executor has none).
 * node-pty itself is a native addon and is NOT packed: terminals need it next to the
 * program (or a `--node-pty` path), and everything else works without it.
 *
 * Usage:
 *   node build-executor-exe.mjs [--out <path>] [--node <node.exe>]
 *
 * The blob is produced by Node itself; the injection needs `postject`, which is
 * resolved from this machine's npx cache or from the engine checkout when present.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const entry = join(home, 'plugins', 'dsh-subprocess-dispatch', 'executor', 'executor.mjs')
// Build outputs live in `dist/`, which is ignored by git: the archive is 80+ MB and
// is reproducible from this script, so committing it would only make the repository
// carry a binary that every clone has to re-download.
const distDir = join(home, 'plugins', 'dsh-subprocess-dispatch', 'dist')
const out = resolve(arg('--out', join(distDir, 'dsh-executor.exe')))
const pack = resolve(arg('--pack', join(distDir, 'dsh-executor.zip')))
const nodeExe = arg('--node', process.execPath)
const work = join(home, '.build', 'executor-exe')

if (!existsSync(entry)) {
	console.error(`[build] 找不到 executor 源文件：${entry}`)
	process.exit(2)
}

/** Run a command, streaming its output, and fail loudly. */
function run(file, args, options = {}) {
	execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options })
}

/**
 * The deployment this distribution belongs to: its server URL and machine secret.
 *
 * Read from the profile's own configuration, which is gitignored, and injected into the
 * bundle as defaults. That is what makes the program double-click-ready: the person who
 * receives it has nothing to type, and the machine simply announces itself. The values
 * are still overridable by flags, so a machine pointed at another deployment, or one
 * enrolled the older way, keeps working.
 * @returns `{ server, secret }`, either of which may be empty.
 */
function deploymentDefaults() {
	const profile = join(home, 'profiles', 'web-client', 'cordis.patch.yml')
	try {
		const text = readFileSync(profile, 'utf8')
		// A targeted read rather than a YAML parse: this script has no YAML dependency and
		// the two values are single-line scalars in a file whose structure it does not own.
		const secret = /^\s*machineSecret:\s*'([^']+)'/m.exec(text)?.[1] ?? ''
		const serverUrl = /^\s*serverUrl:\s*'([^']+)'/m.exec(text)?.[1] ?? ''
		return { server: serverUrl, secret }
	} catch (error) {
		console.warn(`[build] 读不到 ${profile}：${String(error?.message ?? error)}`)
		return { server: '', secret: '' }
	}
}

const defaults = deploymentDefaults()
if (defaults.secret === '') {
	console.warn('[build] 警告：web-client profile 里没有 machineSecret —— 构建出的 exe 将需要 --secret 才能注册')
} else {
	console.log(`[build] 注入部署默认值：server=${defaults.server || '(未配置)'} secret=已设置(${defaults.secret.length} 字符)`)
}

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(distDir, { recursive: true })
const blob = join(work, 'executor.blob')
const bundle = join(work, 'executor.cjs')
const seaConfig = join(work, 'sea-config.json')

console.log('[build] 1/4 打包成 CommonJS（SEA 只跑 CJS）…')
const esbuild = arg('--esbuild', '') || findEsbuild()
if (esbuild === undefined || !existsSync(esbuild)) {
	console.error('[build] 找不到 esbuild：用 --esbuild <esbuild.exe> 指定，或 `npm i -g esbuild`')
	process.exit(1)
}
run(esbuild, [
	entry,
	'--bundle',
	'--platform=node',
	'--format=cjs',
	'--target=node22',
	// node-pty is a native addon: bundling it would inline a .node file into the blob,
	// which cannot work. It stays a runtime require next to the program.
	'--external:node-pty',
	// The deployment this archive belongs to, so a double-click connects with nothing
	// typed. Defined as *globals* because that is the form the executor reads: a bare
	// identifier would be a ReferenceError when the same source is run directly by Node,
	// and evaluating the name in a string cannot see a define at all.
	`--define:globalThis.DEPLOYMENT_SERVER=${JSON.stringify(defaults.server)}`,
	`--define:globalThis.DEPLOYMENT_SECRET=${JSON.stringify(defaults.secret)}`,
	`--outfile=${bundle}`,
])
if (!existsSync(bundle)) {
	console.error('[build] CJS 打包失败')
	process.exit(1)
}

writeFileSync(seaConfig, JSON.stringify({
	main: bundle,
	output: blob,
	disableExperimentalSEAWarning: true,
}, null, 2))

console.log('[build] 2/4 生成 SEA blob…')
run(nodeExe, ['--experimental-sea-config', seaConfig], { cwd: work })
if (!existsSync(blob)) {
	console.error('[build] blob 没有生成')
	process.exit(1)
}

console.log('[build] 3/4 复制 Node 运行时并注入 blob…')
// `postject` ships as a dependency of some toolchains rather than of Node itself, so
// look in the places this machine actually has before falling back to npx. The npx
// cache is included because that is where `npx postject` leaves it — and a build that
// needs the network every time is a build that stops working on a laptop.
const postjectCandidates = [
	join(home, 'node_modules', 'postject', 'dist', 'cli.js'),
	join('C:', 'nvm4w', 'nodejs', 'node_modules', '@playwright', 'mcp', 'node_modules', 'postject', 'dist', 'cli.js'),
	...npxCachePostject(),
]
const postject = postjectCandidates.find((candidate) => existsSync(candidate))
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
mkdirSync(dirname(out), { recursive: true })
copyFileSync(nodeExe, out)
const inject = (script) => run(nodeExe, [
	script, out, 'NODE_SEA_BLOB', blob,
	'--sentinel-fuse', fuse,
])
if (postject !== undefined) {
	console.log(`[build]   用 ${postject}`)
	inject(postject)
} else {
	// Windows resolves `npx` as npx.cmd, which execFileSync will not find without a
	// shell — the first version of this script died on exactly that.
	console.log('[build]   （本机没有 postject，走 npx —— 需要网络或已有缓存）')
	execFileSync('npx.cmd', ['--yes', 'postject', out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', fuse], { stdio: 'inherit', shell: true })
}

/**
 * Find a usable esbuild on this machine: the engine checkout keeps several under
 * pnpm, and any of them can emit the CJS entry SEA needs.
 * @returns Path to esbuild.exe, or undefined.
 */
function findEsbuild() {
	const pnpm = join('C:', 'nvm4w', 'nodejs', 'node_modules')
	const roots = [
		join(home, 'node_modules', '.pnpm'),
		'C:\\Users\\bestarc\\Desktop\\deepseek-harness\\node_modules\\.pnpm',
	]
	for (const root of roots) {
		// Each root is scanned on its own: a root that does not exist must not stop the
		// search, and a machine that has the engine but no local `node_modules` under
		// `.dsh` is the normal case rather than a failure.
		let entries
		try {
			entries = readdirSync(root)
		} catch {
			continue
		}
		for (const dir of entries) {
			if (!dir.startsWith('@esbuild+win32-x64@')) continue
			const candidate = join(root, dir, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
			if (existsSync(candidate)) return candidate
		}
	}
	return existsSync(join(pnpm, 'esbuild', 'bin', 'esbuild'))
		? join(pnpm, 'esbuild', 'bin', 'esbuild')
		: undefined
}

/** postject copies left behind by earlier `npx postject` runs. */
function npxCachePostject() {
	const cache = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
	try {
		return readdirSync(cache).map((entry) => join(cache, entry, 'node_modules', 'postject', 'dist', 'cli.js'))
	} catch {
		return []
	}
}

/**
 * A node-pty on this machine, to answer whether the built exe can allocate a ConPTY.
 *
 * Only the self-check uses this: the deployed exe is pointed at the client machine's
 * own copy, which is why `--node-pty` exists at all.
 * @returns Path to a loadable node-pty entry, or undefined.
 */
function findNodePty() {
	const roots = [
		join(home, 'node_modules', '.pnpm'),
		join(home, 'node_modules'),
		'C:\\Users\\bestarc\\Desktop\\deepseek-harness\\node_modules\\.pnpm',
	]
	for (const root of roots) {
		let entries
		try {
			entries = readdirSync(root)
		} catch {
			continue
		}
		// A store entry or a flat install, in either layout, is enough to spawn from.
		const candidates = entries
			.filter((dir) => dir.startsWith('node-pty@'))
			.map((dir) => join(root, dir, 'node_modules', 'node-pty'))
			.concat(entries.includes('node-pty') ? [join(root, 'node-pty')] : [])
		for (const pkg of candidates) {
			const entry = join(pkg, 'lib', 'index.js')
			if (existsSync(entry)) return entry
		}
	}
	return undefined
}

/**
 * Copy the part of node-pty the executor actually loads next to the archive.
 *
 * The published package is 25 MB, and most of that is debug symbols (`.pdb`) and
 * prebuilds for platforms this deployment does not target. What a Windows x64 client
 * loads is the JavaScript entry points plus one prebuild directory, and a trimmed copy
 * of exactly those — 1.6 MB — was measured to spawn a ConPTY from the built exe.
 * `lib` is copied whole rather than file by file: several modules are `require`d by
 * name from inside it, and a missing one would surface only at terminal-start time.
 * @param entry - A loadable node-pty entry point, as `findNodePty` returns.
 * @returns The staged directory beside the program, or undefined when it did not stage.
 */
function stageNodePty(entry) {
	// Callers hold an entry point (`.../node-pty/lib/index.js`, or a bare package name
	// from `--node-pty`), so the package root is derived rather than required of them.
	// Both a flat and a pnpm store layout put `index.js` in `<package>/lib/`, so the
	// package is always two levels up regardless of what contains it.
	const source = basename(entry) === 'index.js' ? dirname(dirname(entry)) : entry
	const staged = join(work, 'pack', 'node-pty')
	mkdirSync(join(staged, 'prebuilds'), { recursive: true })
	const copyTree = (from, to) => execFileSync('powershell.exe', [
		'-NoProfile', '-NonInteractive', '-Command',
		`Copy-Item -Path '${from}' -Destination '${to}' -Recurse -Force`,
	], { stdio: ['ignore', 'pipe', 'pipe'] })
	copyTree(join(source, 'lib'), join(staged, 'lib'))
	copyFileSync(join(source, 'package.json'), join(staged, 'package.json'))
	const prebuild = join(source, 'prebuilds', 'win32-x64')
	if (!existsSync(prebuild)) return undefined
	copyTree(prebuild, join(staged, 'prebuilds', 'win32-x64'))
	// Debug symbols are never loaded at runtime and are most of the package's size.
	for (const name of readdirSync(join(staged, 'prebuilds', 'win32-x64'))) {
		if (name.endsWith('.pdb')) rmSync(join(staged, 'prebuilds', 'win32-x64', name), { force: true })
	}
	copyFileSync(out, join(work, 'pack', 'dsh-executor.exe'))
	return staged
}

console.log('[build] 4/5 自检：跑一下这个 exe…')
let checked = '未检查'
try {
	const versionLine = execFileSync(out, ['--version'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
	checked = `--version 输出 ${JSON.stringify(versionLine.trim().slice(0, 60))}`
} catch (error) {
	// `--version` is not a supported flag; what matters is that the program started
	// and reported something of its own rather than failing to unpack.
	checked = `启动即报 ${JSON.stringify(String(error?.stdout ?? error?.message ?? error).trim().slice(0, 80))}`
}
// The exe cannot load a native addon by bare name — nothing is installed next to it —
// so the terminal capability is shipped as "point it at a node-pty with --node-pty",
// or as a copy unpacked beside the program. That claim is worth exactly one local
// test: run the same load-and-spawn the socket path uses, against the node-pty this
// build found.
const ptyForTest = arg('--node-pty', '') || findNodePty()
let terminalReport = '未测试（本机没有可指路的 node-pty）'
if (ptyForTest !== undefined) {
	try {
		const line = execFileSync(out, ['--self-test', '--node-pty', ptyForTest], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
		terminalReport = line.trim().split('\n').filter((l) => l.includes('[self-test]')).slice(-1)[0].replace(/^\[self-test\]\s*/, '')
	} catch (error) {
		const text = String(error?.stdout ?? '').trim() || String(error?.message ?? error)
		terminalReport = `失败：${text.split('\n').slice(-1)[0].slice(0, 200)}`
	}
}

// ── the client distribution ───────────────────────────────────────────────────
// One archive is the whole install: the program, and the native module that gives it
// terminals. A client machine unzips it and double-clicks the launcher, and never
// needs npm, a build toolchain, or a `--node-pty` argument.
console.log('[build] 5/5 打包客户端分发包…')
let packReport = '未打包（本机没有可用的 node-pty）'
if (ptyForTest !== undefined) {
	const staged = stageNodePty(ptyForTest)
	if (staged !== undefined) {
		rmSync(pack, { force: true })
		execFileSync('powershell.exe', [
			'-NoProfile', '-NonInteractive', '-Command',
			`Compress-Archive -Path '${join(work, 'pack')}\\*' -DestinationPath '${pack}' -CompressionLevel Optimal -Force`,
		], { stdio: ['ignore', 'pipe', 'pipe'] })
		// The archive is only useful if what comes out of it works, so the staged copy
		// — not the source package — is what the self-test runs against: this is the
		// exact bytes a client will have on disk.
		try {
			const line = execFileSync(join(work, 'pack', 'dsh-executor.exe'), ['--self-test'], { encoding: 'utf8', timeout: 60000, cwd: join(work, 'pack'), stdio: ['ignore', 'pipe', 'pipe'] })
			const json = line.trim().split('\n').filter((l) => l.includes('[self-test]')).slice(-1)[0].replace(/^\[self-test\]\s*/, '')
			const ok = JSON.parse(json).sawMarker === true
			packReport = `${(statSync(pack).size / 1048576).toFixed(1)} MB，解包后免参数自检 ${ok ? '通过' : '未通过'}`
			if (!ok) console.error(`[build] 警告：解包后的副本拿不到终端 —— ${json}`)
		} catch (error) {
			packReport = `已打包，但解包后自检失败：${String(error?.stdout ?? error?.message ?? error).trim().split('\n').slice(-1)[0].slice(0, 160)}`
		}
	} else {
		packReport = '未打包：这个 node-pty 里没有 win32-x64 预编译产物'
	}
}

const size = (statSync(out).size / 1048576).toFixed(1)
console.log(`[build] 完成：${out}（${size} MB）`)
console.log(`[build] ${checked}`)
console.log(`[build] 终端自检：${terminalReport}`)
console.log(`[build] 客户端分发包：${pack} —— ${packReport}`)
console.log('[build] 提示：node-pty 不打包进 exe —— 它随分发包解包在 exe 旁边，或用 --node-pty 指路；其它功能不需要。')
const version = /const VERSION = '([^']+)'/.exec(readFileSync(entry, 'utf8'))?.[1] ?? '?'
console.log(`[build] 执行器版本：${version}`)
