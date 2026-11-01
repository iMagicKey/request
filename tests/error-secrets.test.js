import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import util from 'node:util'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { Request, stream } from '../src/index.js'
import { rejection, respond, startRawServer, startServer } from './support/servers.js'

const SECRET = 'SyntheticSecret9f2c'
const withSecrets = (origin) => {
    const url = new URL(origin)
    return `${url.protocol}//user:${SECRET}@${url.host}/bot${SECRET}/send?key=${SECRET}`
}

function assertClean(err) {
    assert.ok(err instanceof Error)
    for (const [label, text] of Object.entries({
        message: err.message,
        stack: err.stack,
        inspect: util.inspect(err, { depth: 10, showHidden: true }),
        json: JSON.stringify(err),
    })) {
        assert.equal(String(text).includes(SECRET), false, `${label} contains the secret: ${text}`)
    }
}

describe('errors do not carry URL secrets', () => {
    let badLocation
    let redirectLoop
    let reset
    let silent
    let api

    before(async () => {
        badLocation = await startRawServer((socket) => socket.write('HTTP/1.1 302 Found\r\nLocation: http://[\r\nContent-Length: 0\r\n\r\n'))
        reset = await startRawServer((socket) => socket.destroy())
        silent = await startRawServer()
        redirectLoop = await startServer((req, res) => respond(res, 302, { Location: req.url }, ''))
        api = await startServer((req, res) => {
            const { pathname } = new URL(req.url, 'http://x')
            if (pathname.endsWith('/send')) {
                res.writeHead(200, { 'Content-Encoding': 'gzip' })
                res.end(zlib.gzipSync('data').subarray(0, 8))
                return
            }
            respond(res)
        })
    })

    after(async () => {
        await Promise.all([badLocation.close(), reset.close(), silent.close(), redirectLoop.close(), api.close()])
    })

    describe('Request()', () => {
        it('an invalid Location', async () => {
            const err = await rejection(Request(withSecrets(badLocation.url), { timeout: 5000 }))
            assert.match(err.message, /invalid Location/)
            assert.equal('input' in err, false)
            assert.equal('base' in err, false)
            assertClean(err)
        })

        it('an invalid URL', async () => {
            const err = await rejection(Request(`http://user:${SECRET}@[bad/${SECRET}`, { timeout: 5000 }))
            assert.equal(err.code, 'ERR_INVALID_URL')
            assert.ok(err instanceof TypeError)
            assert.equal('input' in err, false)
            assertClean(err)
        })

        it('an unsupported URL scheme', async () => {
            assertClean(await rejection(Request(`ftp://user:${SECRET}@127.0.0.1/${SECRET}`, { timeout: 5000 })))
        })

        it('too many redirects', async () => {
            assertClean(await rejection(Request(withSecrets(redirectLoop.url), { maxRedirects: 1, timeout: 5000 })))
        })

        it('a refused connection', async () => {
            assertClean(await rejection(Request(withSecrets('http://127.0.0.1:1'), { timeout: 5000 })))
        })

        it('a reset connection', async () => {
            assertClean(await rejection(Request(withSecrets(reset.url), { timeout: 5000 })))
        })

        it('an idle timeout', async () => {
            assertClean(await rejection(Request(withSecrets(silent.url), { timeout: 50 })))
        })

        it('a deadline', async () => {
            assertClean(await rejection(Request(withSecrets(silent.url), { deadline: 50, timeout: 0 })))
        })

        it('an abort', async () => {
            assertClean(await rejection(Request(withSecrets(silent.url), { signal: AbortSignal.timeout(50), timeout: 0 })))
        })

        it('a truncated compressed body', async () => {
            assertClean(await rejection(Request(withSecrets(api.url), { timeout: 5000 })))
        })

        it('a redirect that cannot replay its body', async () => {
            const target = await startServer((_req, res) => respond(res, 307, { Location: '/next' }, ''))
            try {
                const err = await rejection(Request(withSecrets(target.url), { method: 'POST', formData: { upload: Readable.from([Buffer.from('x')]) }, timeout: 5000 }))
                assert.match(err.message, /Cannot follow 307/)
                assertClean(err)
            } finally {
                await target.close()
            }
        })

        it('a redirect to an unsupported protocol', async () => {
            const target = await startServer((_req, res) => respond(res, 302, { Location: `file:///${SECRET}` }, ''))
            try {
                assertClean(await rejection(Request(withSecrets(target.url), { timeout: 5000 })))
            } finally {
                await target.close()
            }
        })

        it('an invalid header name', async () => {
            assertClean(await rejection(Request(withSecrets(api.url), { headers: { 'bad name': 'x' }, timeout: 5000 })))
        })
    })

    describe('stream()', () => {
        it('an invalid URL', async () => {
            const err = await rejection(stream(`http://user:${SECRET}@[bad/${SECRET}`, { timeout: 5000 }))
            assert.equal(err.code, 'ERR_INVALID_URL')
            assert.equal('input' in err, false)
            assertClean(err)
        })

        it('an unsupported URL scheme', async () => {
            assertClean(await rejection(stream(`ftp://user:${SECRET}@127.0.0.1/${SECRET}`, { timeout: 5000 })))
        })

        it('a refused connection', async () => {
            assertClean(await rejection(stream(withSecrets('http://127.0.0.1:1'), { timeout: 5000 })))
        })

        it('a deadline', async () => {
            assertClean(await rejection(stream(withSecrets(silent.url), { deadline: 50, timeout: 0 })))
        })

        it('a truncated compressed body', async () => {
            const res = await stream(withSecrets(api.url), { timeout: 5000 })
            const drain = (async () => {
                for await (const _chunk of res.stream) {
                    /* drain */
                }
            })()
            assertClean(await rejection(drain))
        })
    })
})
