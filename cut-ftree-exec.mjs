/**
 * Remove the execution-location control from the folder-tree plugin's panel header.
 *
 * The block is a long chain inside a React.createElement call, so it is located by its own
 * banner comment and its closing `})() : null,` rather than transcribed: a hand-copied
 * snippet is how the earlier edits to this file went wrong.
 *
 * The plugin is a third-party fork, so this refuses to guess: when the markers are absent
 * it reports what it found instead of cutting somewhere plausible.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = `${process.env.USERPROFILE}\\.dsh\\plugins\\folder-tree-sh-local\\lib\\client.js`
const source = readFileSync(file, 'utf8')

const startMarker = '\t\t\t\t\t\t\t\t// LOCAL FORK (dsh-subprocess-dispatch): execution location + bind control.'
const endMarker = '})() : null,\n'

const start = source.indexOf(startMarker)
if (start < 0) {
	console.log('[cut] 标记不存在 —— 这段已经被移除过')
	process.exit(0)
}
const end = source.indexOf(endMarker, start)
if (end < 0) {
	console.error('[cut] 找不到结束标记，拒绝猜测；请人工检查这一处')
	process.exit(1)
}

const removed = source.slice(start, end + endMarker.length)
// Sanity: the block must be the bind control and nothing else.
for (const must of ['execState', '本地模式', 'runExec']) {
	if (!removed.includes(must)) {
		console.error(`[cut] 将要删除的段落里没有 ${must}，拒绝执行`)
		process.exit(1)
	}
}
const leftover = source.slice(end + endMarker.length, end + endMarker.length + 80)
if (!leftover.includes('dsh-ftree-btn')) {
	console.error('[cut] 结束标记后面不是面板工具栏，拒绝执行')
	process.exit(1)
}

// Collapse the blank line the removal leaves behind inside the createElement argument list.
const cleaned = source.slice(0, start).replace(/\n+$/, '\n') + source.slice(end + endMarker.length)
writeFileSync(file, cleaned)
console.log(`[cut] 已移除 ${removed.split('\n').length} 行`)
