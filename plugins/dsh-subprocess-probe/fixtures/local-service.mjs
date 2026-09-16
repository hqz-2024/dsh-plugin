/**
 * Test fixture for the client-localhost relay (plan P4).
 *
 * Stands in for a service listening on a bound machine's loopback — the place
 * Figma's Dev Mode MCP endpoint would occupy. It exists to make two properties
 * observable that a real MCP endpoint would only demonstrate implicitly:
 *
 *   /ping   Echoes a request header and returns its own, so header forwarding is
 *           visible in both directions.
 *   /sse    Emits one event every 400ms and then closes. A relay that collects
 *           the body before answering delivers all three at once, so the gaps
 *           between arrivals are the evidence that framing survives the hop.
 *
 * Usage: node local-service.mjs [port]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 38450)

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://127.0.0.1')
	if (url.pathname === '/ping') {
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-fixture': 'local-service' })
		res.end(JSON.stringify({
			ok: true,
			method: req.method,
			sawHeader: req.headers['x-probe'] ?? null,
			body: null,
		}))
		return
	}
	if (url.pathname === '/echo') {
		const chunks = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
			res.end(JSON.stringify({ ok: true, method: req.method, body: Buffer.concat(chunks).toString('utf8') }))
		})
		return
	}
	if (url.pathname === '/sse') {
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
			'mcp-session-id': 'fixture-session-1',
		})
		let tick = 0
		let ended = false
		let reported = false
		/** Say how this stream ended — the only place the peer's behaviour is visible. */
		const report = (how) => {
			if (reported) return
			reported = true
			console.log(`[fixture] sse ${how} after ${tick} event(s)`)
		}
		const timer = setInterval(() => {
			tick += 1
			res.write(`event: tick\ndata: ${tick}\n\n`)
			if (tick >= 3) {
				clearInterval(timer)
				ended = true
				res.end()
			}
		}, 400)
		res.on('finish', () => { ended = true })
		// A caller that walks away (browser tab closed, request aborted) must take the
		// upstream down with it. That is what the relay's `http.abort` is for, and this
		// line is the only place it becomes observable: `ended` distinguishes the
		// stream that finished on its own from the one that was cut off.
		res.on('close', () => {
			clearInterval(timer)
			report(ended ? 'completed normally' : 'aborted by the caller')
		})
		return
	}
	res.writeHead(404, { 'content-type': 'text/plain' })
	res.end('no such path')
})

server.listen(port, '127.0.0.1', () => {
	console.log(`[fixture] listening on 127.0.0.1:${port}`)
})
