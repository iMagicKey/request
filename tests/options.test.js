import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { Request, stream } from '../src/index.js'
import { bounded, rejection, respond, startServer } from './support/servers.js'

const isAbort = (err) => err.name === 'AbortError' || err.name === 'TimeoutError'
const grace = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

describe('explicit options and cancellation', () => {
    let server
    let onHit = () => {}

    before(async () => {
        server = await startServer((req, res) => {
            onHit(req)
            const { pathname, searchParams } = new URL(req.url, 'http://x')
            switch (pathname) {
                case '/redirect':
                    respond(res, Number(searchParams.get('status')) || 302, { Location: searchParams.get('to') ?? '/final' }, '')
                    return
                case '/final':
                    respond(res, 200, {}, 'final')
                    return
                case '/fail':
                    respond(res, 503, {}, 'unavailable')
                    return
                case '/never':
                    return
                case '/stall-body':
                    res.writeHead(200)
                    res.write('partial')
                    return
                case '/stall-gzip': {
                    res.writeHead(200, { 'Content-Encoding': 'gzip' })
                    const compressed = zlib.gzipSync(Buffer.alloc(4096, 'x'))
                    res.write(compressed.subarray(0, compressed.length / 2))
                    return
                }
                default:
                    respond(res)
            }
        })
    })

    after(() => server.close())

    const reset = () => {
        server.requests.length = 0
        onHit = () => {}
    }

    describe('maxRedirects: 0', () => {
        it('does not follow a redirect and rejects, as exceeding the limit always has', async () => {
            reset()
            const err = await rejection(Request(`${server.url}/redirect`, { maxRedirects: 0, timeout: 5000 }))
            assert.match(err.message, /Maximum number of redirects exceeded \(0\)/)
            assert.deepEqual(
                server.requests.map((r) => r.url),
                ['/redirect']
            )
        })

        it('still returns a response that is not a redirect', async () => {
            const res = await Request(`${server.url}/final`, { maxRedirects: 0, timeout: 5000 })
            assert.equal(res.buffer.toString(), 'final')
        })

        it('maxRedirects: 1 allows exactly one hop (control)', async () => {
            const res = await Request(`${server.url}/redirect`, { maxRedirects: 1, timeout: 5000 })
            assert.equal(res.buffer.toString(), 'final')
        })

        it('leaving maxRedirects unset keeps the default of 10', async () => {
            reset()
            const hops = (n) => (n === 0 ? '/final' : `/redirect?to=${encodeURIComponent(hops(n - 1))}`)
            const res = await Request(`${server.url}${hops(10)}`, { timeout: 5000 })
            assert.equal(res.buffer.toString(), 'final')
            const err = await rejection(Request(`${server.url}${hops(11)}`, { timeout: 5000 }))
            assert.match(err.message, /Maximum number of redirects exceeded \(10\)/)
        })
    })

    describe('retryDelay: 0', () => {
        it('retries with no base delay instead of the 1000 ms default', async () => {
            reset()
            const started = performance.now()
            const res = await bounded(Request(`${server.url}/fail`, { retry: 3, retryDelay: 0, timeout: 5000 }), 10000)
            const elapsed = performance.now() - started
            assert.equal(res.statusCode, 503)
            assert.equal(server.requests.length, 4)
            // The old default would need at least 1000 + 2000 + 4000 ms here.
            assert.ok(elapsed < 3000, `took ${elapsed} ms`)
        })
    })

    describe('abort', () => {
        it('rejects without contacting the server when already aborted, and never retries', async () => {
            reset()
            const started = performance.now()
            const err = await rejection(Request(`${server.url}/final`, { signal: AbortSignal.abort(), retry: 3, retryDelay: 60000, timeout: 5000 }))
            assert.equal(err.name, 'AbortError')
            assert.ok(performance.now() - started < 2000)
            await grace()
            assert.equal(server.requests.length, 0)
        })

        it('keeps the abort reason as err.cause', async () => {
            const reason = new Error('synthetic reason')
            const err = await rejection(Request(`${server.url}/final`, { signal: AbortSignal.abort(reason), timeout: 5000 }))
            assert.equal(err.name, 'AbortError')
            assert.equal(err.cause, reason)
        })

        it('does not retry an abort that happens while waiting for a response', async () => {
            reset()
            const controller = new AbortController()
            onHit = () => setImmediate(() => controller.abort())
            const err = await rejection(Request(`${server.url}/never`, { signal: controller.signal, retry: 3, retryDelay: 1, timeout: 0 }))
            assert.ok(isAbort(err), `unexpected ${err.name}: ${err.message}`)
            await grace()
            assert.equal(server.requests.length, 1)
        })

        it('rejects promptly when aborted during retry backoff', async () => {
            reset()
            const controller = new AbortController()
            onHit = () => setTimeout(() => controller.abort(), 50)
            const started = performance.now()
            const err = await rejection(Request(`${server.url}/fail`, { signal: controller.signal, retry: 3, retryDelay: 60000, timeout: 5000 }))
            assert.equal(err.name, 'AbortError')
            assert.ok(performance.now() - started < 3000)
            assert.equal(server.requests.length, 1)
        })

        for (const path of ['/stall-body', '/stall-gzip']) {
            it(`rejects with an abort error while receiving ${path}`, async () => {
                reset()
                const controller = new AbortController()
                onHit = () => setTimeout(() => controller.abort(), 50)
                const err = await rejection(Request(`${server.url}${path}`, { signal: controller.signal, retry: 3, retryDelay: 1, timeout: 0 }))
                assert.ok(isAbort(err), `unexpected ${err.name}: ${err.message}`)
                await grace()
                assert.equal(server.requests.length, 1)
            })
        }

        it('stops a redirect chain when aborted between hops', async () => {
            reset()
            const controller = new AbortController()
            onHit = () => controller.abort()
            const err = await rejection(Request(`${server.url}/redirect`, { signal: controller.signal, timeout: 5000 }))
            assert.ok(isAbort(err), `unexpected ${err.name}: ${err.message}`)
            await grace()
            assert.equal(server.requests.length, 1)
        })

        it('AbortSignal.timeout() is not retried either', async () => {
            reset()
            const err = await rejection(Request(`${server.url}/never`, { signal: AbortSignal.timeout(50), retry: 3, retryDelay: 1, timeout: 0 }))
            assert.ok(isAbort(err), `unexpected ${err.name}: ${err.message}`)
            await grace()
            assert.equal(server.requests.length, 1)
        })

        it('stream() rejects when already aborted', async () => {
            const err = await rejection(stream(`${server.url}/final`, { signal: AbortSignal.abort(), timeout: 5000 }))
            assert.equal(err.name, 'AbortError')
        })
    })

    describe('stream() cancellation', () => {
        for (const path of ['/stall-body', '/stall-gzip']) {
            it(`errors the returned stream when aborted while receiving ${path}`, async () => {
                const controller = new AbortController()
                const res = await bounded(stream(`${server.url}${path}`, { signal: controller.signal, timeout: 0 }))
                setTimeout(() => controller.abort(), 50)
                const drain = (async () => {
                    for await (const _chunk of res.stream) {
                        /* drain */
                    }
                })()
                const err = await rejection(drain)
                assert.ok(err instanceof Error)
            })
        }
    })

    describe('stream request bodies and redirects', () => {
        const form = () => ({ upload: Readable.from([Buffer.from('stream body')]) })

        for (const status of [307, 308]) {
            it(`fails clearly on a ${status} redirect`, async () => {
                reset()
                const err = await rejection(Request(`${server.url}/redirect?status=${status}`, { method: 'POST', formData: form(), timeout: 5000 }))
                assert.match(err.message, new RegExp(`Cannot follow ${status} redirect: .*cannot be replayed`))
                assert.equal(err instanceof TypeError, false)
                assert.equal(server.requests.length, 1)
            })
        }

        it('fails clearly when 301 keeps the method and body of a PUT', async () => {
            reset()
            const err = await rejection(Request(`${server.url}/redirect?status=301`, { method: 'PUT', formData: form(), timeout: 5000 }))
            assert.match(err.message, /Cannot follow 301 redirect: .*cannot be replayed/)
        })

        it('follows a redirect that drops the body', async () => {
            reset()
            const res = await Request(`${server.url}/redirect?status=303`, { method: 'POST', formData: form(), timeout: 5000 })
            assert.equal(res.buffer.toString(), 'final')
            assert.equal(server.requests[1].method, 'GET')
            assert.equal(server.requests[1].headers['content-type'], undefined)
        })

        for (const [name, body] of [
            ['string', 'replayable'],
            ['Buffer', Buffer.from('replayable')],
        ]) {
            it(`replays a ${name} body on 307 (control)`, async () => {
                reset()
                const res = await Request(`${server.url}/redirect?status=307`, { method: 'POST', body, timeout: 5000 })
                assert.equal(res.buffer.toString(), 'final')
                assert.equal(server.requests[1].method, 'POST')
                assert.equal(server.requests[1].body.toString(), 'replayable')
            })
        }

        it('does not retry with a stream body that has already been consumed', async () => {
            reset()
            const res = await Request(`${server.url}/fail`, { method: 'PUT', formData: form(), retry: 2, retryDelay: 1, timeout: 5000 })
            assert.equal(res.statusCode, 503)
            assert.equal(server.requests.length, 1)
        })
    })

    describe('stream() request bodies', () => {
        const drain = async (res) => {
            for await (const _chunk of res.stream) {
                /* drain */
            }
        }

        it('sends a string body', async () => {
            reset()
            await drain(await bounded(stream(`${server.url}/final`, { method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' }, timeout: 5000 })))
            assert.equal(server.requests[0].method, 'POST')
            assert.equal(server.requests[0].body.toString(), 'hello')
        })

        it('sends a Buffer body byte-identical', async () => {
            reset()
            const body = Buffer.from(Array.from({ length: 256 }, (_v, i) => i))
            await drain(await bounded(stream(`${server.url}/final`, { method: 'POST', body, timeout: 5000 })))
            assert.deepEqual(server.requests[0].body, body)
        })

        it('sends formData as multipart, without modifying caller headers', async () => {
            reset()
            const headers = { 'X-Keep': 'yes' }
            await drain(await bounded(stream(`${server.url}/final`, { method: 'POST', formData: { field: 'value' }, headers, timeout: 5000 })))
            assert.match(server.requests[0].headers['content-type'], /^multipart\/form-data; boundary=/)
            assert.ok(server.requests[0].body.includes('name="field"'))
            assert.deepEqual(headers, { 'X-Keep': 'yes' })
        })

        it('rejects a body of the wrong type, as Request does', () => {
            assert.throws(() => stream(`${server.url}/final`, { method: 'POST', body: { a: 1 } }), /body must be a string or Buffer/)
        })

        it('still works with no body (control)', async () => {
            reset()
            await drain(await bounded(stream(`${server.url}/final`, { timeout: 5000 })))
            assert.equal(server.requests[0].body.length, 0)
        })
    })
})
