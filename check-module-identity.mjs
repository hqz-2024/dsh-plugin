/**
 * Does the booted tree hold ONE instance of @deepseek-ai/dsh-tools?
 *
 * Two instances (one loaded from a package's `src`, one from its `lib`) give
 * two different `TOOL_RUNTIME_SCHEDULER` symbols, so agent-loop reports
 * "Cannot read properties of undefined (reading 'prepare')" on the first tool
 * call of any conversation. That is what a `node --import tsx/esm
 * apps/cli/src/bin.ts` launch does in dsh-0.1.6: tsx maps the engine's own
 * imports to `src` through tsconfig paths, while the profile loader resolves
 * plugin rows to `lib`.
 *
 * Usage (server host, a spare port, never 3080):
 *   set DSH_HOME=%TEMP%\dsh-identity-check
 *   cd C:\Users\bestarc\Desktop\dsh-0.1.6
 *   node apps\cli\lib\bin.js --profile web --patch C:\Users\bestarc\.dsh\check-module-identity.yml --port 3099 --no-open
 *   type C:\Users\bestarc\.dsh\module-identity-report.json
 *
 * `ok: true` requires BOTH a single loaded instance and the built launcher.
 * The source launcher is reported as `ok: false` even when the registry looks
 * single-instanced here: with tsx the engine's own agent-loop still ends up on
 * a different copy, and only a real tool call proves otherwise. The report is
 * written before the process exits itself.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPORT = 'C:\\Users\\bestarc\\.dsh\\module-identity-report.json'
const ENGINE_ROOT = 'C:/Users/bestarc/Desktop/dsh-0.1.6'

export const name = 'module-identity-check'
export const inject = ['tools']

export function apply(ctx) {
  const report = {
    pid: process.pid,
    cwd: process.cwd(),
    execArgv: process.execArgv,
    launchMode: process.execArgv.some((arg) => String(arg).includes('tsx')) ? 'source (tsx)' : 'built (lib/bin.js)',
  }
  const tools = ctx.get('tools')
  const libTools = createRequire(`${ENGINE_ROOT}/apps/cli/package.json`).resolve('@deepseek-ai/dsh-tools')
  const loadSrc = import(`file:///${ENGINE_ROOT}/packages/core/tools/src/index.ts`)
    .then((mod) => mod, (error) => ({ __error: String(error) }))
  Promise.all([import(pathToFileURL(libTools).href), loadSrc]).then(([lib, src]) => {
    report.toolRegistryFromLib = tools[lib.TOOL_RUNTIME_SCHEDULER] !== undefined
    report.toolRegistryFromSrc = src.TOOL_RUNTIME_SCHEDULER !== undefined
      && tools[src.TOOL_RUNTIME_SCHEDULER] !== undefined
    report.libAndSrcSymbolsEqual = src.TOOL_RUNTIME_SCHEDULER !== undefined
      && lib.TOOL_RUNTIME_SCHEDULER === src.TOOL_RUNTIME_SCHEDULER
    report.toolsSymbolIsEngineInstance = report.toolRegistryFromLib || report.toolRegistryFromSrc
    report.launchModeIsBuilt = report.launchMode.startsWith('built')
    report.ok = report.toolsSymbolIsEngineInstance
      && report.launchModeIsBuilt
      && (report.libAndSrcSymbolsEqual || report.toolRegistryFromLib)
    mkdirSync(dirname(REPORT), { recursive: true })
    writeFileSync(REPORT, `${JSON.stringify(report, undefined, 2)}\n`)
    setTimeout(() => process.exit(report.ok ? 0 : 1), 300)
  })
}
