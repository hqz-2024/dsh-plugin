/**
 * Probe what the running Desktop window actually shows, through the renderer's
 * DevTools protocol.
 *
 * Reading the window from outside is the only way to assert the mode switch
 * without trusting the shell's own log lines: the page URL, the native title,
 * and the banner the preload injected are three independent observations of
 * "which deployment is this window displaying".
 *
 * Usage: node check-desktop-window.mjs [debugPort] [--switch]
 *
 * `--switch` clicks the mode banner's action, which is the same path a person
 * takes: banner → preload IPC → main-process switch → new document. The report
 * is then read again after the switch settles.
 */
const port = Number(process.argv.find(argument => /^\d+$/u.test(argument)) ?? 9222)
const switching = process.argv.includes('--switch')

/**
 * Ask the renderer one expression and return its value.
 * @param socket - the page target's DevTools socket.
 * @param id - message id for this request.
 * @param expression - JavaScript evaluated in the page.
 */
function evaluate(socket, id, expression) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (message.error !== undefined) { reject(new Error(JSON.stringify(message.error))); return }
      resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('CDP evaluate timed out')) }, 10_000)
  })
}

const report = async (click = false) => {
  const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
  const page = targets.find(target => target.type === 'page')
  if (page === undefined) throw new Error('no page target on the renderer debug port')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => { reject(new Error('CDP socket failed')) }, { once: true })
  })
  const banner = `(() => {
    const host = document.querySelector('[data-dsh-mode-banner]')
    const pill = host?.shadowRoot?.firstElementChild
    const action = pill?.querySelector('button')
    return host === null || host === undefined
      ? { present: false }
      : { present: true, text: pill?.firstElementChild?.textContent ?? null, title: pill?.firstElementChild?.title ?? null,
          action: action?.textContent ?? null }
  })()`
  const state = {
    url: page.url,
    documentOrigin: await evaluate(socket, 1, 'location.origin'),
    banner: await evaluate(socket, 2, banner),
    desktopBridge: await evaluate(socket, 3, 'typeof globalThis.dshDesktopBoot'),
  }
  if (click) {
    await evaluate(socket, 4, `document.querySelector('[data-dsh-mode-banner]')?.shadowRoot?.querySelector('button')?.click() ?? 'no banner'`)
    socket.close()
    // The switch loads another document; the target list is re-read after it settles.
    await new Promise(resolve => setTimeout(resolve, 8_000))
    return { before: state, after: await report(false) }
  }
  socket.close()
  return state
}

console.log(JSON.stringify(await report(switching), null, 2))
