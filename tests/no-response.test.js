import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Request, stream } from '../src/index.js'
import { bounded, moduleUrl, rejection, respond, runChild, startRawServer, startServer } from './support/servers.js'

const UPGRADE = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n'
const WAIT_MS = 5000

/** Sockets close asynchronously after the client destroys them, so wait for the server to notice, within a limit. */
async function allClosed(server) {
    const started = Date.now()
    while (server.state.closed < server.state.connections) {
        assert.ok(Date.now() - started < WAIT_MS, `only ${server.state.closed} of ${server.state.connections} sockets closed`)
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

describe('responses that are not usable HTTP responses', () => {
    let upgrade
    let bareUpgrade
    let tunnel
    let tunnelRefused
    let plain

    before(async () => {
        upgrade = await startRawServer((socket) => socket.write(UPGRADE))
        bareUpgrade = await startRawServer((socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n'))
        tunnel = await startRawServer((socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'))
        tunnelRefused = await startRawServer((socket) => socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'))
        plain = await startServer((_req, res) => respond(res, 302, { Location: upgrade.url }, ''))
    })

    after(async () => {
        await Promise.all([upgrade.close(), bareUpgrade.close(), tunnel.close(), tunnelRefused.close(), plain.close()])
    })

    describe('Request()', () => {
        const cases = {
            'default options': {},
            'timeout: 100': { timeout: 100 },
            'deadline: 100': { deadline: 100 },
            'timeout: 0': { timeout: 0 },
        }
        for (const [name, options] of Object.entries(cases)) {
            it(`rejects a 101 with ${name}`, async () => {
                const err = await rejection(Request(upgrade.url, options), WAIT_MS)
                assert.match(err.message, /Unexpected 101 response/)
            })
        }

        it('returns a 101 that has no Upgrade header, since node:http treats it as an ordinary response', async () => {
            const res = await bounded(Request(bareUpgrade.url, { timeout: 0 }), WAIT_MS)
            assert.equal(res.statusCode, 101)
            assert.equal(res.buffer.length, 0)
        })

        it('rejects a 2xx to CONNECT', async () => {
            const err = await rejection(Request(tunnel.url, { method: 'CONNECT', timeout: 0 }), WAIT_MS)
            assert.match(err.message, /Unexpected 200 response/)
        })

        it('rejects a non-2xx to CONNECT', async () => {
            const err = await rejection(Request(tunnelRefused.url, { method: 'CONNECT', timeout: 0 }), WAIT_MS)
            assert.match(err.message, /Unexpected 407 response/)
        })

        it('rejects when a redirect leads to a 101', async () => {
            const err = await rejection(Request(plain.url, { timeout: 0 }), WAIT_MS)
            assert.match(err.message, /Unexpected 101 response/)
        })

        it('still honours retry', async () => {
            const before_ = upgrade.state.connections
            const err = await rejection(Request(upgrade.url, { retry: 2, retryDelay: 1, timeout: 0, agent: false }), WAIT_MS)
            assert.match(err.message, /Unexpected 101 response/)
            assert.equal(upgrade.state.connections - before_, 3)
        })

        it('reports an abort that came first as an abort', async () => {
            const err = await rejection(Request(upgrade.url, { signal: AbortSignal.abort(), timeout: 0 }), WAIT_MS)
            assert.equal(err.name, 'AbortError')
        })

        it('does not leak the socket', async () => {
            await rejection(Request(upgrade.url, { timeout: 0 }), WAIT_MS)
            await rejection(Request(tunnel.url, { method: 'CONNECT', timeout: 0 }), WAIT_MS)
            await allClosed(upgrade)
            await allClosed(tunnel)
        })

        it('rejects when the request closes without any response event', async () => {
            // No real server path reaches this today, so an agent closes the request directly.
            const agent = {
                addRequest(request) {
                    setImmediate(() => request.emit('close'))
                },
            }
            const err = await rejection(Request('http://127.0.0.1:1/', { agent, timeout: 0 }), WAIT_MS)
            assert.match(err.message, /closed before a response was received/)
        })

        it('lets a real process exit instead of ending on an unsettled await', async () => {
            const script = `
                import { Request } from ${JSON.stringify(moduleUrl)}
                try {
                    await Request(${JSON.stringify(upgrade.url)}, { deadline: 500, timeout: 500 })
                    console.log('resolved')
                } catch (err) {
                    console.log('rejected', err.message)
                }
            `
            const { code, stdout } = await runChild(script)
            assert.equal(code, 0, `exit code 13 means an unsettled top-level await. stdout: ${stdout}`)
            assert.match(stdout, /^rejected Unexpected 101 response/)
        })
    })

    describe('stream()', () => {
        it('rejects a 101', async () => {
            const err = await rejection(stream(upgrade.url, { timeout: 0 }), WAIT_MS)
            assert.match(err.message, /Unexpected 101 response/)
        })

        it('rejects a 2xx to CONNECT', async () => {
            const err = await rejection(stream(tunnel.url, { method: 'CONNECT', timeout: 0 }), WAIT_MS)
            assert.match(err.message, /Unexpected 200 response/)
        })

        it('does not leak the socket', async () => {
            await rejection(stream(upgrade.url, { timeout: 0 }), WAIT_MS)
            await allClosed(upgrade)
        })

        it('rejects when the request closes without any response event', async () => {
            const agent = {
                addRequest(request) {
                    setImmediate(() => request.emit('close'))
                },
            }
            const err = await rejection(stream('http://127.0.0.1:1/', { agent, timeout: 0 }), WAIT_MS)
            assert.match(err.message, /closed before a response was received/)
        })
    })
})
