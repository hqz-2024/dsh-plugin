/**
 * Insert the execution-location styles into the folder-tree plugin's CSS literal.
 *
 * The stylesheet is one long escaped JavaScript string, so the text to match contains
 * `\n` characters rather than newlines and cannot be typed reliably by hand. This finds
 * the rule for the header buttons and appends the new rules after it, refusing to run
 * twice.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = `${process.env.USERPROFILE}\\.dsh\\plugins\\folder-tree-sh-local\\lib\\client.js`
const source = readFileSync(file, 'utf8')

if (source.includes('dsh-ftree-exec-chip')) {
	console.log('[patch] already applied')
	process.exit(0)
}

const anchor = '.dsh-ftree-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:4px;padding:1px 6px;font-size:11px;cursor:pointer;flex:none;}\\n'
if (!source.includes(anchor)) {
	console.error('[patch] anchor not found — the plugin changed; inspect lib/client.js CSS before patching')
	process.exit(1)
}

const added = anchor
	+ '/* LOCAL FORK (dsh-subprocess-dispatch): execution-location chip and its action. */\\n'
	+ '.dsh-ftree-btn.disabled{opacity:.45;cursor:default;}\\n'
	+ '.dsh-ftree-exec-chip{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px;font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;cursor:default;}\\n'
	+ '.dsh-ftree-exec-chip.on{border-color:#1a7f37;color:#1a7f37;}\\n'
	+ '.dsh-ftree-exec-note{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;}\\n'

writeFileSync(file, source.replace(anchor, added))
console.log('[patch] styles inserted')
