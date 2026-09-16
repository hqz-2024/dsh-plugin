// link-proxy.mjs — a TCP relay with a file-driven "cut" switch.
//
// The disconnect cases the client world must survive are not the same thing as
// killing the executor: a killed process closes its socket, so both ends learn
// about it. A link that simply stops delivering (cable pulled, Wi-Fi dropped,
// VPN renegotiating) sends no FIN and no RST, so neither end learns anything and
// every liveness check that relies on the socket's `close` event stays silent.
//
// This relay sits between an executor and its server and, when the control file
// says `cut`, keeps both TCP connections established while dropping every byte
// in both directions. That is the silent case, reproduced on one machine.
//
// Usage:
//   node link-proxy.mjs --listen 3092 --target 3084 --control <path>
//
// The control file is re-read every 100ms; its trimmed content is `cut` to
// sever and anything else (or a missing file) to forward.

import { createServer, connect } from 'node:net'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const listenPort = Number(arg('--listen', '3092'))
const targetHost = arg('--target-host', '127.0.0.1')
const targetPort = Number(arg('--target', '3084'))
const controlPath = arg('--control', 'link-state.txt')

let open = true
let droppedUp = 0
let droppedDown = 0

const readSwitch = () => {
	try {
		return readFileSync(controlPath, 'utf8').trim() !== 'cut'
	} catch {
		return true
	}
}

setInterval(() => {
	const next = readSwitch()
	if (next === open) return
	open = next
	if (open) {
		console.log(`[link-proxy] OPEN at ${new Date().toISOString()} (dropped while cut: up=${droppedUp} down=${droppedDown})`)
		droppedUp = 0
		droppedDown = 0
	} else {
		console.log(`[link-proxy] CUT at ${new Date().toISOString()} — connections stay established, bytes are dropped`)
	}
}, 100)

createServer((client) => {
	const upstream = connect(targetPort, targetHost)
	console.log(`[link-proxy] pair ${client.remoteAddress}:${client.remotePort} -> ${targetHost}:${targetPort}`)

	client.on('data', (chunk) => {
		if (open) upstream.write(chunk)
		else droppedUp += chunk.length
	})
	upstream.on('data', (chunk) => {
		if (open) client.write(chunk)
		else droppedDown += chunk.length
	})

	const shut = (why) => {
		console.log(`[link-proxy] pair closed (${why})`)
		client.destroy()
		upstream.destroy()
	}
	client.on('error', () => shut('client error'))
	upstream.on('error', () => shut('upstream error'))
	client.on('close', () => shut('client closed'))
	upstream.on('close', () => shut('upstream closed'))
}).listen(listenPort, '127.0.0.1', () => {
	console.log(`[link-proxy] listening on 127.0.0.1:${listenPort} -> ${targetHost}:${targetPort}; control=${controlPath}`)
})
