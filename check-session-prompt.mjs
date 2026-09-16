/**
 * Report whether a session's LOGGED system prompt contains the execution:world
 * section (plan §2.8.3) -- the claim that a session in a bound workspace is told
 * where its commands run.
 *
 * Why this is the check that matters: the section is rebuilt at assembly time from
 * live state, so it is NOT stored as a section anywhere -- but the assembled prompt
 * is recorded in the session's `request/header` event. That makes the session log
 * the only place a REAL session's prompt can be inspected after the fact, which is
 * what distinguishes "the render function returns the right string" from "an agent
 * actually received it".
 *
 * Usage:
 *   node check-session-prompt.mjs <session.jsonl.zstd> [--dump]
 *
 * Session logs are one zstd FRAME PER EVENT, not a single stream: Node's
 * zstdDecompressSync stops after the first frame, so decoding the file in one call
 * reports a single event for a log that holds hundreds. Frames are split on the
 * zstd magic instead.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const file = process.argv[2]
const dump = process.argv.includes('--dump')

if (!file) {
	console.error('usage: node check-session-prompt.mjs <session.jsonl.zstd> [--dump]')
	process.exit(2)
}

/** Decode every zstd frame in one session log into its events. */
function readSessionEvents(path) {
	const buf = readFileSync(path)
	const starts = []
	for (let at = buf.indexOf(MAGIC); at !== -1; at = buf.indexOf(MAGIC, at + 1)) starts.push(at)
	starts.push(buf.length)
	const events = []
	for (let i = 0; i < starts.length - 1; i++) {
		try {
			const text = zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8')
			for (const line of text.split('\n')) {
				if (!line.trim()) continue
				try { events.push(JSON.parse(line)) } catch { /* a split line, skip */ }
			}
		} catch {
			// Not a frame boundary; the next magic will resynchronise.
		}
	}
	return events
}

const events = readSessionEvents(file)
const header = events.find((event) => event?.type === 'request/header')
const session = events.find((event) => event?.type === 'session')
const system = header?.data?.header?.system ?? ''

console.log(JSON.stringify({
	// The `session` event carries its fields at the top level; the others nest under `data`.
	sessionId: session?.id ?? session?.data?.id ?? null,
	cwd: session?.cwd ?? session?.data?.cwd ?? null,
	events: events.length,
	hasRequestHeader: Boolean(header),
	systemPromptChars: system.length,
	/** Markdown headings in the assembled prompt, so a missing section is visible by name. */
	sections: [...system.matchAll(/^#\s+(.+)$/gm)].map((m) => m[1]),
	hasExecutionWorld: system.includes('# Where your commands run'),
}, null, 2))

if (dump) {
	const at = system.indexOf('# Where your commands run')
	console.log('---')
	console.log(at < 0 ? '(execution:world absent from this session prompt)' : system.slice(at, at + 900))
}
