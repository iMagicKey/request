import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import zlib from 'node:zlib'
import { Request, stream } from '../src/index.js'
import { bounded, rejection, startServer } from './support/servers.js'

const PAYLOAD = Buffer.concat([Buffer.alloc(32 * 1024, 'compressible text '), randomBytes(32 * 1024)])
const ENCODERS = {
    gzip: (data) => zlib.gzipSync(data),
    deflate: (data) => zlib.deflateSync(data),
    br: (data) => zlib.brotliCompressSync(data),
}
// Hard limit on every wait, well under the harness timeout. timeout: 0 removes the idle timer, which a hang could otherwise hide behind.
const WAIT_MS = 5000

describe('compressed responses', () => {
    let server

    before(async () => {
        server = await startServer((req, res, record) => {
            const { pathname, searchParams } = new URL(req.url, 'http://x')
            const encoding = searchParams.get('encoding')
            const compressed = ENCODERS[encoding] ? ENCODERS[encoding](PAYLOAD) : Buffer.alloc(0)
            const headers = { 'Content-Encoding': encoding }

            switch (pathname) {
                case '/valid':
                    res.writeHead(200, headers)
                    res.end(record.method === 'HEAD' ? undefined : compressed)
                    return
                case '/truncated-then-reset':
                    res.writeHead(200, headers)
                    res.write(compressed.subarray(0, Math.floor(compressed.length / 2)), () => {
                        setImmediate(() => res.socket.destroy())
                    })
                    return
                case '/truncated-content-length':
                    res.writeHead(200, { ...headers, 'Content-Length': compressed.length })
                    res.write(compressed.subarray(0, Math.floor(compressed.length / 2)), () => {
                        setImmediate(() => res.socket.destroy())
                    })
                    return
                case '/headers-then-reset':
                    res.writeHead(200, headers)
                    res.flushHeaders()
                    setImmediate(() => res.socket.destroy())
                    return
                case '/truncated-clean-end':
                    res.writeHead(200, headers)
                    res.end(compressed.subarray(0, Math.floor(compressed.length / 2)))
                    return
                case '/garbage':
                    res.writeHead(200, headers)
                    res.end(Buffer.from('this is not a compressed body, not even slightly'))
                    return
                case '/no-content':
                    res.writeHead(204, headers)
                    res.end()
                    return
                default:
                    res.writeHead(404)
                    res.end()
            }
        })
    })

    after(() => server.close())

    for (const encoding of Object.keys(ENCODERS)) {
        const url = (path) => `${server.url}${path}?encoding=${encoding}`

        describe(`${encoding} via Request()`, () => {
            it('decompresses a valid body byte for byte (positive control)', async () => {
                const res = await bounded(Request(url('/valid'), { timeout: 0 }), WAIT_MS)
                assert.equal(res.statusCode, 200)
                assert.equal(res.buffer.equals(PAYLOAD), true)
            })

            it('rejects when the socket dies part-way through the body', async () => {
                const err = await rejection(Request(url('/truncated-then-reset'), { timeout: 0 }), WAIT_MS)
                assert.ok(err instanceof Error)
                assert.ok(Buffer.isBuffer(err.buffer), 'partial data is documented on err.buffer')
            })

            it('rejects when the socket dies before a declared Content-Length arrives', async () => {
                const err = await rejection(Request(url('/truncated-content-length'), { timeout: 0 }), WAIT_MS)
                assert.ok(err instanceof Error)
            })

            it('rejects when the socket dies right after the headers', async () => {
                const err = await rejection(Request(url('/headers-then-reset'), { timeout: 0 }), WAIT_MS)
                assert.ok(err instanceof Error)
            })

            it('rejects a compressed stream that ends early on a clean connection', async () => {
                const err = await rejection(Request(url('/truncated-clean-end'), { timeout: 0 }), WAIT_MS)
                assert.ok(err instanceof Error)
            })

            it('rejects a garbage body', async () => {
                const err = await rejection(Request(url('/garbage'), { timeout: 0 }), WAIT_MS)
                assert.ok(err instanceof Error)
            })

            it('resolves with an empty buffer for a bodiless HEAD response', async () => {
                const res = await bounded(Request(url('/valid'), { method: 'HEAD', timeout: 0 }), WAIT_MS)
                assert.equal(res.statusCode, 200)
                assert.equal(res.buffer.length, 0)
            })

            it('resolves with an empty buffer for a bodiless 204 response', async () => {
                const res = await bounded(Request(url('/no-content'), { timeout: 0 }), WAIT_MS)
                assert.equal(res.statusCode, 204)
                assert.equal(res.buffer.length, 0)
            })

            it('enforces maxBodySize on the decompressed size', async () => {
                const err = await rejection(Request(url('/valid'), { maxBodySize: 1024, timeout: 0 }), WAIT_MS)
                assert.match(err.message, /maxBodySize/)
            })

            it('retries a truncated body like any other network error', async () => {
                const before = server.requests.length
                await rejection(Request(url('/truncated-then-reset'), { retry: 1, retryDelay: 1, timeout: 0 }), WAIT_MS)
                assert.equal(server.requests.length - before, 2)
            })
        })

        describe(`${encoding} via stream()`, () => {
            const drain = async (promise) => {
                const res = await promise
                const chunks = []
                for await (const chunk of res.stream) chunks.push(chunk)
                return Buffer.concat(chunks)
            }

            it('decompresses a valid body byte for byte (positive control)', async () => {
                const body = await bounded(drain(stream(url('/valid'), { timeout: 0 })), WAIT_MS)
                assert.equal(body.equals(PAYLOAD), true)
            })

            it('errors the stream when the socket dies part-way through the body', async () => {
                const err = await rejection(drain(stream(url('/truncated-then-reset'), { timeout: 0 })), WAIT_MS)
                assert.ok(err instanceof Error)
            })

            it('errors the stream on a garbage body', async () => {
                const err = await rejection(drain(stream(url('/garbage'), { timeout: 0 })), WAIT_MS)
                assert.ok(err instanceof Error)
            })

            it('does not crash the process when the caller attaches no error listener', async () => {
                const uncaught = []
                const onUncaught = (err) => uncaught.push(err)
                process.on('uncaughtException', onUncaught)
                try {
                    const res = await bounded(stream(url('/garbage'), { timeout: 0 }), WAIT_MS)
                    await bounded(
                        new Promise((resolve) => {
                            res.stream.once('close', resolve)
                            res.stream.resume()
                        }),
                        WAIT_MS
                    )
                    await new Promise((resolve) => setImmediate(resolve))
                    assert.deepEqual(uncaught, [])
                } finally {
                    process.off('uncaughtException', onUncaught)
                }
            })
        })
    }

    it('still rejects an uncompressed truncated body (identity control)', async () => {
        const err = await rejection(Request(`${server.url}/truncated-then-reset?encoding=identity`, { timeout: 0 }), WAIT_MS)
        assert.ok(err instanceof Error)
    })
})
