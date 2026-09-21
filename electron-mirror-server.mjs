/**
 * 本地 Electron 镜像：把已经下载并核对过哈希的那份 electron zip 用 HTTP 喂给
 * `@electron/get`，绕开 GitHub release 上那个稳定复现的 150 MB 传输失败。
 *
 * 只服务一个版本目录，且 SHASUMS256.txt 用的是**上游发布的那一份原文** ——
 * 所以 sumchecker 校验的是上游声明的哈希，不是我们自己算的。
 *
 * 用法：node electron-mirror-server.mjs <服务目录> [端口]
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, normalize } from 'node:path'

const root = process.argv[2]
const port = Number(process.argv[3] ?? 8791)
if (root === undefined) throw new Error('用法：node electron-mirror-server.mjs <服务目录> [端口]')

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
  const target = normalize(join(root, pathname))
  if (!target.startsWith(normalize(root))) {
    response.writeHead(403).end()
    return
  }
  let size
  try {
    size = statSync(target).size
  } catch {
    console.log(`mirror 404 ${pathname}`)
    response.writeHead(404).end()
    return
  }
  console.log(`mirror 200 ${pathname} (${String(Math.round(size / 1024 / 1024))} MB)`)
  response.writeHead(200, { 'content-length': String(size), 'content-type': 'application/octet-stream' })
  if (request.method === 'HEAD') { response.end(); return }
  createReadStream(target).pipe(response)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`electron mirror serving ${root} at http://127.0.0.1:${String(port)}/`)
})
