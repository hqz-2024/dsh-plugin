/**
 * Accept the released v2 "interrupted turn restart" shape during the v2→v3
 * Session migration.
 *
 * Why: a v2 log may hold a turn whose model call was interrupted (an empty
 * `assistant/attempt`), then `step/end` with no `turn/end`, and the next
 * `turn/start` right after an `agent/inbox/spliced` carrying the retried user
 * message. The released v0→v1 / v1→v2 readers admit that shape through the
 * `legacyInterruptedTurnRestart` relationship flag (the engine's own test
 * helpers pass it), but `RELEASED_V2_RELATIONSHIP_EXTENSIONS` in
 * `@deepseek-ai/dsh-session-format-v1-to-v2` omits it, so the v2→v3 migration
 * refuses such a log and the conversation cannot be opened at all.
 *
 * How: this hook appends the one missing flag to that module's source while
 * Node loads it. The engine checkout is never modified — when upstream fixes
 * the omission, delete this hook (and its registration).
 *
 * Fails loud: if the anchor text moves (an upstream change), the hook reports
 * on stderr and leaves the module untouched, which shows up in
 * `~/.dsh/live-0.1.6.err.log` instead of silently reintroducing the refusal.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const TARGET_SUFFIX = '/session-format-v1-to-v2/lib/index.js'
const ANCHOR = 'preservedSourceTitleRequestText: true'
const ADDITION = ',\n\tlegacyInterruptedTurnRestart: true'
const APPLIED_LOG = join(process.env.USERPROFILE ?? '.', '.dsh', 'engine-patches', 'applied.log')

/**
 * Node ESM load hook: append the missing relationship flag to the released
 * v1→v2 validation module.
 * @param url - module URL Node is loading.
 * @param context - loader context forwarded to the next hook.
 * @param nextLoad - the remaining loader chain.
 * @returns the (possibly patched) load result.
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (!url.endsWith(TARGET_SUFFIX)) return result
  if (typeof result.source !== 'string' && !Buffer.isBuffer(result.source)) return result
  const text = result.source.toString()
  if (text.includes('legacyInterruptedTurnRestart')) return result
  if (!text.includes(ANCHOR)) {
    process.stderr.write(`[dsh-lan] engine patch FAILED: anchor missing in ${url}; v2 logs with an interrupted turn will be refused\n`)
    return result
  }
  try {
    appendFileSync(APPLIED_LOG, `${new Date().toISOString()} patched ${url}\n`)
  } catch {}
  process.stderr.write('[dsh-lan] engine patch: legacy-turn-restart applied\n')
  return { ...result, source: text.replace(ANCHOR, ANCHOR + ADDITION) }
}
