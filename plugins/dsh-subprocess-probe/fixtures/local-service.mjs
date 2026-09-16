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
		const timer = setInterval(() => {
			tick += 1
			res.write(`event: tick\ndata: ${tick}\n\n`)
			if (tick >= 3) {
				clearInterval(timer)
				res.end()
			}
		}, 400)
		return
	}
	res.writeHead(404, { 'content-type': 'text/plain' })
	res.end('no such path')
})

server.listen(port, '127.0.0.1', () => {
	console.log(`[fixture] listening on 127.0.0.1:${port}`)
})
