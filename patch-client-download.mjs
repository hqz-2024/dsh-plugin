/**
 * 给 dsh-remote-local 的宿主侧加"桌面客户端安装包"这一项。
 *
 * 设置页「本地插件」本来就是按列表渲染卡片 + 「下载」按钮的，所以只要让
 * /auth/local-plugins 多返回一项、并把它的 downloadUrl 指向一条真实路由，页面上就
 * 自动出现这张卡片 —— 客户端的渲染代码一行都不用动。
 *
 * 只改这一个文件，且用不带动首空白的唯一锚点定位（文件里是 tab 缩进）。
 * 用法：node patch-client-download.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const target = 'C:/Users/bestarc/.dsh/plugins/dsh-remote-local/lib/index.js'
const dryRun = process.argv.includes('--dry-run')
let text = readFileSync(target, 'utf8')

// 幂等：第二次跑会再插一个 ...clientInstallerEntries()，列表里就出现两张一样的卡片。
if (text.includes('/auth/client-installer')) {
  console.log('这个补丁已经打过了（路由 /auth/client-installer 已在文件里），什么都不做。')
  process.exit(0)
}

/** 断言锚点在全文里唯一，然后返回它的位置。 */
const locate = (anchor) => {
  const first = text.indexOf(anchor)
  if (first < 0) throw new Error(`锚点没找到：${anchor}`)
  if (text.indexOf(anchor, first + 1) >= 0) throw new Error(`锚点不唯一：${anchor}`)
  return first
}

const resolver = [
  '\t// 设置页「本地插件」里的桌面客户端安装包。',
  '\t//',
  '\t// 目录和文件都由部署决定：$DSH_HOME/client/dist 下最新的那个 .exe 就是当前分发的版本，',
  '\t// 所以"发新版本"= 把新 exe 丢进目录，不改代码、不重启进程。目录里没有 exe 时这一项整个',
  '\t// 不出现 —— 没构建过客户端的部署不该在设置页里留一个点不动的下载按钮。',
  '\tconst CLIENT_DIST_ENV = "DSH_CLIENT_DIST";',
  '\tconst clientDistDir = () => {',
  '\t\tconst configured = String(process.env[CLIENT_DIST_ENV] ?? "").trim();',
  '\t\treturn configured === "" ? join(dshHomePath(), "client", "dist") : configured;',
  '\t};',
  '\tconst clientInstaller = () => {',
  '\t\tlet names = [];',
  '\t\ttry { names = readdirSync(clientDistDir()); } catch { return null; }',
  '\t\tlet newest = null;',
  '\t\tfor (const name of names) {',
  '\t\t\tif (!/\\.exe$/i.test(name)) continue;',
  '\t\t\tconst path = join(clientDistDir(), name);',
  '\t\t\tlet stat = null;',
  '\t\t\ttry { stat = statSync(path); } catch { continue; }',
  '\t\t\tif (!stat.isFile()) continue;',
  '\t\t\tif (newest === null || stat.mtimeMs > newest.mtimeMs) newest = { path, name, size: stat.size, mtimeMs: stat.mtimeMs };',
  '\t\t}',
  '\t\treturn newest;',
  '\t};',
  '\tconst clientInstallerEntries = () => {',
  '\t\tconst found = clientInstaller();',
  '\t\tif (found === null) return [];',
  '\t\treturn [{',
  '\t\t\tid: "desktop-client",',
  '\t\t\tname: "桌面客户端（可选）",',
  '\t\t\tdescription: `${found.name} · ${(found.size / 1048576).toFixed(1)} MB，装在这台 Windows 电脑上。`',
  '\t\t\t\t+ "自带运行时，本机不需要预装 Node 或 dsh；装完可用服务器模式（用本部署的界面）或"',
  '\t\t\t\t+ "本地模式（agent 跑在本机，模型走部署的网关）。",',
  '\t\t\tdownloadUrl: "/auth/client-installer",',
  '\t\t\tfilename: found.name',
  '\t\t}];',
  '\t};',
  '',
  '',
].join('\n')

const handler = [
  '\t// 流式送安装包：293 MB 走内存会白白占一份，直接 pipe 文件流。',
  '\tconst handleClientInstaller = async (req, res) => {',
  '\t\tif (req.method !== "GET" && req.method !== "HEAD") { denyJson(res, 405, "method not allowed"); return; }',
  '\t\tconst verdict = requireAuth(req);',
  '\t\tif (!verdict.ok) { denyJson(res, 401, "unauthorized"); return; }',
  '\t\tconst found = clientInstaller();',
  '\t\tif (found === null) {',
  '\t\t\tdenyJson(res, 404, `客户端安装包不在 ${clientDistDir()}：把 exe 放进去即可`);',
  '\t\t\treturn;',
  '\t\t}',
  '\t\tres.writeHead(200, {',
  '\t\t\t"Content-Type": "application/octet-stream",',
  '\t\t\t"Content-Disposition": `attachment; filename="${found.name}"`,',
  '\t\t\t"Content-Length": found.size,',
  '\t\t\t"Cache-Control": "no-store"',
  '\t\t});',
  '\t\tif (req.method === "HEAD") { res.end(); return; }',
  '\t\tconst stream = createReadStream(found.path);',
  '\t\tstream.on("error", () => { res.destroy(); });',
  '\t\tres.on("close", () => { stream.destroy(); });',
  '\t\tstream.pipe(res);',
  '\t};',
  '',
  '',
].join('\n')

// 1) 解析器放在 handleLocalPlugins 之前（它是唯一消费者）。
const localPluginsAt = locate('const handleLocalPlugins = async (req, res) => {')
text = text.slice(0, localPluginsAt) + resolver + text.slice(localPluginsAt)

// 2) 列表末尾追加这一项。用 manifest-tool 的 filename 当锚点，向前找到它的收尾 `}],`。
const manifestToolAt = locate('filename: "manifest-tool.exe"')
const arrayCloseAt = text.indexOf('}],', manifestToolAt)
if (arrayCloseAt < 0) throw new Error('找不到 plugs 列表的收尾 }],')
text = text.slice(0, arrayCloseAt) + '}, ...clientInstallerEntries()],' + text.slice(arrayCloseAt + 3)

// 3) 处理器放在 handleExecutorPack 与 handleBootstrap 之间。
const bootstrapAt = locate('const handleBootstrap = async (req, res) => {')
text = text.slice(0, bootstrapAt) + handler + text.slice(bootstrapAt)

// 4) 注册路由（跟着 executor-pack，同样只在认证开启时挂）。
const packRouteAt = locate('path: "/auth/executor-pack"')
const packLineEnd = text.indexOf('\n', packRouteAt)
const routeLine = '\n\t\tdisposers.push(originalRegister({ kind: "exact", path: "/auth/client-installer", handler: handleClientInstaller }));'
text = text.slice(0, packLineEnd) + routeLine + text.slice(packLineEnd)

if (dryRun) {
  console.log('--dry-run：未写盘。将新增 resolver / 列表项 / 处理器 / 路由各一处。')
} else {
  writeFileSync(target, text, 'utf8')
  console.log(`已写入 ${target}（${text.length} 字符）`)
}
