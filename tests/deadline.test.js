import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { Request, stream } from '../src/index.js'
import { bounded, rejection, respond, startServer } from './support/servers.js'

const isDeadline = (err) => err.name === 'TimeoutError' && err.code === 'ETIMEDOUT' && /deadline/.test(err.message)

describe('deadline option', () => {
    let server
    const timers = new Set()

    /** Send a byte every 20 ms until the client goes away: far too active for any idle timeout. */
    function trickle(res, chunk = 'x') {
        const timer = setInterval(() => res.write(chunk), 20)
        timers.add(timer)
        res.on('close', () => {
            clearInterval(timer)
            timers.delete(timer)
        })
    }

    before(async () => {
        server = await startServer((req, res) => {
            const { pathname } = new URL(req.url, 'http://x')
            switch (pathname) {
                case '/trickle':
                    res.writeHead(200)
                    trickle(res)
                    return
                case '/trickle-gzip': {
                    res.writeHead(200, { 'Content-Encoding': 'gzip' })
                    const gzip = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })
                    gzip.pipe(res)
                    const timer = setInterval(() => gzip.write('x'), 20)
                    timers.add(timer)
                    res.on('close', () => {
                        clearInterval(timer)
                        timers.delete(timer)
                    })
                    return
                }
                case '/never':
                    return
                case '/loop':
                    setTimeout(() => respond(res, 302, { Location: '/loop' }, ''), 30)
                    return
                case '/fail':
                    respond(res, 503)
                    return
                default:
                    respond(res, 200, {}, 'done')
            }
        })
    })

    after(async () => {
        for (const timer of timers) clearInterval(timer)
        await server.close()
    })

    const reset = () => {
        server.requests.length = 0
    }

    describe('Request()', () => {
        it('stops a trickling body that an idle timeout never catches', async () => {
            const started = performance.now()
            const err = await rejection(Request(`${server.url}/trickle`, { deadline: 300, timeout: 5000 }))
            const elapsed = performance.now() - started
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
            assert.ok(elapsed >= 250, `fired early, after ${elapsed} ms`)
            assert.ok(elapsed < 3000, `fired late, after ${elapsed} ms`)
            assert.ok(err.buffer.length > 0, 'partial data is attached')
        })

        it('leaves timeout meaning idle time: the same server is not stopped by it (control)', async () => {
            const controller = new AbortController()
            const pending = Request(`${server.url}/trickle`, { timeout: 200, signal: controller.signal })
            const outcome = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((resolve) => setTimeout(resolve, 800, 'still running'))])
            assert.equal(outcome, 'still running')
            controller.abort()
            await rejection(pending)
        })

        it('stops a trickling compressed body', async () => {
            const err = await rejection(Request(`${server.url}/trickle-gzip`, { deadline: 300, timeout: 5000 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
        })

        it('covers waiting for the response', async () => {
            const err = await rejection(Request(`${server.url}/never`, { deadline: 200, timeout: 0 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
        })

        it('covers connecting', async () => {
            // A lookup that never answers keeps the connection attempt pending without leaving loopback.
            const err = await rejection(Request('http://stuck.invalid/', { deadline: 200, timeout: 0, lookup: () => {} }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
        })

        it('covers a whole redirect chain, not each hop', async () => {
            reset()
            const err = await rejection(Request(`${server.url}/loop`, { deadline: 300, maxRedirects: 1000, timeout: 5000 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
            assert.ok(server.requests.length > 1, 'the chain must have advanced')
        })

        it('covers retries and does not retry after expiring', async () => {
            reset()
            const err = await rejection(Request(`${server.url}/fail`, { deadline: 300, retry: 1000, retryDelay: 20, timeout: 5000 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
            const count = server.requests.length
            assert.ok(count > 1, 'the request must have been retried')
            await new Promise((resolve) => setTimeout(resolve, 100))
            assert.equal(server.requests.length, count)
        })

        it('interrupts a long retry backoff', async () => {
            const started = performance.now()
            const err = await rejection(Request(`${server.url}/fail`, { deadline: 200, retry: 3, retryDelay: 60000, timeout: 5000 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
            assert.ok(performance.now() - started < 3000)
        })

        it('covers a request body that never finishes', async () => {
            const upload = new Readable({ read() {} })
            upload.push('start')
            const err = await rejection(Request(`${server.url}/never`, { method: 'POST', formData: { upload }, deadline: 200, timeout: 0 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
            upload.destroy()
        })

        it('returns normally when the response finishes in time (control)', async () => {
            const res = await bounded(Request(`${server.url}/done`, { deadline: 3000, timeout: 5000 }))
            assert.equal(res.buffer.toString(), 'done')
        })

        it('is disabled by 0 and when unset, like timeout', async () => {
            assert.equal((await bounded(Request(`${server.url}/done`, { deadline: 0, timeout: 5000 }))).statusCode, 200)
            assert.equal((await bounded(Request(`${server.url}/done`, { timeout: 5000 }))).statusCode, 200)
        })

        it('reports a caller abort as an abort, not as a deadline', async () => {
            const err = await rejection(Request(`${server.url}/never`, { deadline: 60000, signal: AbortSignal.timeout(50), timeout: 0 }))
            assert.equal(err.name, 'AbortError')
        })

        it('reports an already aborted caller signal as an abort', async () => {
            const err = await rejection(Request(`${server.url}/done`, { deadline: 60000, signal: AbortSignal.abort() }))
            assert.equal(err.name, 'AbortError')
        })

        it('does not abort the caller signal when the deadline fires', async () => {
            const controller = new AbortController()
            const err = await rejection(Request(`${server.url}/never`, { deadline: 100, signal: controller.signal, timeout: 0 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
            assert.equal(controller.signal.aborted, false, 'the caller signal must not be aborted by the deadline')
        })

        for (const value of [-1, NaN, Infinity, '100', null, 2 ** 31]) {
            it(`rejects an invalid value: ${String(value)}`, async () => {
                const err = await rejection(Request(`${server.url}/done`, { deadline: value }))
                assert.match(err.message, /deadline must be a number of milliseconds/)
            })
        }

        it('does not keep the process alive after the response', async () => {
            const moduleUrl = new URL('../src/index.js', import.meta.url).href
            const script = `
                import { Request } from ${JSON.stringify(moduleUrl)}
                const res = await Request(${JSON.stringify(`${server.url}/done`)}, { deadline: 120000, timeout: 5000, agent: false })
                console.log(res.statusCode)
            `
            const stdout = await bounded(
                new Promise((resolve, reject) => {
                    execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('.', import.meta.url)), timeout: 20000 }, (err, out) => {
                        if (err) reject(err)
                        else resolve(out)
                    })
                }),
                25000
            )
            assert.equal(stdout.trim(), '200')
        })

        it('does not modify the caller options', async () => {
            const options = { deadline: 3000, timeout: 5000 }
            await Request(`${server.url}/done`, options)
            assert.deepEqual(options, { deadline: 3000, timeout: 5000 })
        })
    })

    describe('stream()', () => {
        const drain = async (res) => {
            const chunks = []
            for await (const chunk of res.stream) chunks.push(chunk)
            return Buffer.concat(chunks)
        }

        it('rejects when the response headers do not arrive in time', async () => {
            const err = await rejection(stream(`${server.url}/never`, { deadline: 200, timeout: 0 }))
            assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
        })

        for (const path of ['/trickle', '/trickle-gzip']) {
            it(`errors the returned stream when ${path} outlasts it`, async () => {
                const res = await bounded(stream(`${server.url}${path}`, { deadline: 300, timeout: 5000 }))
                const err = await rejection(drain(res))
                assert.ok(isDeadline(err), `unexpected ${err.name}: ${err.message}`)
            })
        }

        it('completes normally in time (control)', async () => {
            const res = await bounded(stream(`${server.url}/done`, { deadline: 3000, timeout: 5000 }))
            assert.equal((await bounded(drain(res))).toString(), 'done')
        })

        it('throws on an invalid value, as for other invalid options', () => {
            assert.throws(() => stream(`${server.url}/done`, { deadline: -1 }), /deadline must be a number of milliseconds/)
        })
    })
})
