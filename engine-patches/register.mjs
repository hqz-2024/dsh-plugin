/**
 * Registers every deployment-side runtime engine patch.
 *
 * The engine checkout stays byte-identical to upstream; these hooks rewrite a
 * module's source as Node loads it. Launched by start-dsh-lan.cmd through
 * `node --import <this file> apps\cli\lib\bin.js ...`.
 */
import { register } from 'node:module'

register('./legacy-turn-restart.mjs', import.meta.url)
