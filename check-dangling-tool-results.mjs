/**
 * Which sessions hold a tool call with no matching tool result?
 *
 * A scheduler failure (for example the module-identity crash) leaves the
 * `tool/call` event without its `tool/result`. DeepSeek rejects any request
 * whose assistant message advertises a tool call that is not immediately
 * followed by results ("Messages tool calls need immediate results"), so such
 * a conversation cannot take another turn until the missing results exist.
 *
 * Read-only: decodes session logs, prints one line per session, writes nothing.
 *
 *   node check-dangling-tool-results.mjs [--project <substring>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ROOT = join(homedir(), '.dsh', 'sessions')

function decodeFrames(buffer) {
  const starts = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 1)) starts.push(at)
  starts.push(buffer.length)
  const events = []
  for (let index = 0; index < starts.length - 1; index++) {
    try {
      for (const line of zstdDecompressSync(buffer.subarray(starts[index], starts[index + 1])).toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line))
        } catch {}
      }
    } catch {}
  }
  return events
}

function newestGeneration(dir) {
  const names = readdirSync(dir)
    .map((name) => {
      const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
      return match ? { name, version: match[1] === undefined ? 0 : Number(match[1]) } : undefined
    })
    .filter(Boolean)
    .sort((left, right) => right.version - left.version)
  return names[0]?.name
}

const filter = process.argv.includes('--project')
  ? process.argv[process.argv.indexOf('--project') + 1]
  : undefined

let danglingTotal = 0
let affected = 0
for (const project of readdirSync(ROOT)) {
  if (filter !== undefined && !project.includes(filter)) continue
  const projectDir = join(ROOT, project)
  if (!statSync(projectDir).isDirectory()) continue
  for (const session of readdirSync(projectDir)) {
    const dir = join(projectDir, session)
    let file
    try {
      if (!statSync(dir).isDirectory()) continue
      file = newestGeneration(dir)
    } catch {
      continue
    }
    if (file === undefined) continue
    const events = decodeFrames(readFileSync(join(dir, file)))
    const open = new Map()
    for (const event of events) {
      const data = event.data ?? {}
      if (event.type === 'tool/call' && typeof data.callId === 'string') open.set(data.callId, data.name)
      if (event.type === 'tool/result') {
        for (const block of data.message?.content ?? []) {
          if (typeof block.toolCallId === 'string') open.delete(block.toolCallId)
        }
      }
    }
    if (open.size === 0) continue
    affected += 1
    danglingTotal += open.size
    console.log(`${project}/${session}  file=${file}  dangling=${open.size}`)
    for (const [callId, name] of open) console.log(`    ${name}  ${callId}`)
  }
}
console.log(`\naffected sessions: ${affected}, dangling calls: ${danglingTotal}`)
