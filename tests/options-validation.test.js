import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Request, stream } from '../src/index.js'
import { bounded, rejection, respond, startRawServer, startServer } from './support/servers.js'

const NOT_NUMBERS = { NaN, 'a string': 'abc', 'a numeric string': '2', 'an object': {}, 'an array': [], true: true, false: false, 'a function': () => 1, 'a symbol': Symbol('x'), 'a bigint': 1n }
const OUT_OF_RANGE = { Infinity, '-Infinity': -Infinity, 'a negative number': -1 }

describe('numeric safety options', () => {
    let server

    before(async () => {
        server = await startServer((req, res) => {
            if (req.url === '/redirect') respond(res, 302, { Location: '/final' }, '')
            else if (req.url === '/ten') respond(res, 200, {}, Buffer.alloc(10))
            else if (req.url === '/fail') respond(res, 503)
            else respond(res)
        })
    })

    after(() => server.close())

    const invalid = {
        maxRedirects: { ...NOT_NUMBERS, ...OUT_OF_RANGE, 'a fraction': 0.5, 'an unsafe integer': 2 ** 53 },
        maxBodySize: { ...NOT_NUMBERS, ...OUT_OF_RANGE, 'a fraction': 1.5, 'an unsafe integer': 2 ** 53 },
        retryDelay: { ...NOT_NUMBERS, ...OUT_OF_RANGE, 'more than a timer can hold': 2 ** 31 },
    }
    const messages = {
        maxRedirects: /maxRedirects must be a non-negative integer/,
        maxBodySize: /maxBodySize must be a non-negative integer/,
        retryDelay: /retryDelay must be a number of milliseconds/,
    }

    for (const [option, values] of Object.entries(invalid)) {
        describe(option, () => {
            for (const [name, value] of Object.entries(values)) {
                it(`rejects ${name} without contacting the server or retrying`, async () => {
                    server.requests.length = 0
                    const err = await rejection(Request(`${server.url}/redirect`, { [option]: value, retry: 2, timeout: 5000 }))
                    assert.match(err.message, messages[option])
                    assert.equal(server.requests.length, 0)
                })
            }

            for (const value of [undefined, null]) {
                it(`treats ${value} as unset`, async () => {
                    const res = await bounded(Request(`${server.url}/ok`, { [option]: value, timeout: 5000 }))
                    assert.equal(res.statusCode, 200)
                })
            }
        })
    }

    describe('valid values keep working', () => {
        it('maxRedirects counts hops', async () => {
            await rejection(Request(`${server.url}/redirect`, { maxRedirects: 0, timeout: 5000 }))
            assert.equal((await bounded(Request(`${server.url}/redirect`, { maxRedirects: 1, timeout: 5000 }))).statusCode, 200)
        })

        it('maxRedirects null keeps the default rather than following forever', async () => {
            const loop = await startServer((req, res) => respond(res, 302, { Location: req.url }, ''))
            try {
                const err = await rejection(Request(loop.url, { maxRedirects: null, timeout: 5000 }))
                assert.match(err.message, /Maximum number of redirects exceeded \(10\)/)
            } finally {
                await loop.close()
            }
        })

        it('maxBodySize is exact, and 0 means unlimited', async () => {
            const err = await rejection(Request(`${server.url}/ten`, { maxBodySize: 9, timeout: 5000 }))
            assert.match(err.message, /maxBodySize/)
            assert.equal((await bounded(Request(`${server.url}/ten`, { maxBodySize: 10, timeout: 5000 }))).buffer.length, 10)
            assert.equal((await bounded(Request(`${server.url}/ten`, { maxBodySize: 0, timeout: 5000 }))).buffer.length, 10)
        })

        for (const retryDelay of [0, 1, 1.5]) {
            it(`retryDelay ${retryDelay} retries`, async () => {
                server.requests.length = 0
                await bounded(Request(`${server.url}/fail`, { retry: 1, retryDelay, timeout: 5000 }))
                assert.equal(server.requests.length, 2)
            })
        }

        it('the largest retryDelay a timer can hold is accepted', async () => {
            assert.equal((await bounded(Request(`${server.url}/ok`, { retry: 1, retryDelay: 2 ** 31 - 1, timeout: 5000 }))).statusCode, 200)
        })
    })

    describe('a fractional deadline behaves the same in Request() and stream()', () => {
        let silent

        before(async () => {
            silent = await startRawServer()
        })

        after(() => silent.close())

        for (const deadline of [1.5, 0.5, 100.25]) {
            it(`Request() enforces ${deadline}`, async () => {
                const err = await rejection(Request(silent.url, { deadline, timeout: 0 }))
                assert.equal(err.name, 'TimeoutError', err.message)
            })

            it(`stream() enforces ${deadline}`, async () => {
                const err = await rejection(stream(silent.url, { deadline, timeout: 0 }))
                assert.equal(err.name, 'TimeoutError', err.message)
            })
        }

        it('both report the same rounded-up limit', async () => {
            const fromRequest = await rejection(Request(silent.url, { deadline: 1.5, timeout: 0 }))
            const fromStream = await rejection(stream(silent.url, { deadline: 1.5, timeout: 0 }))
            assert.equal(fromRequest.message, 'Request deadline of 2 ms exceeded')
            assert.equal(fromStream.message, fromRequest.message)
        })
    })

    it('reports a signal that is not an AbortSignal as what it is, not as an abort', async () => {
        const err = await rejection(Request(`${server.url}/ok`, { signal: { aborted: false }, retry: 1, retryDelay: 1, timeout: 5000 }))
        assert.notEqual(err.name, 'AbortError')
        assert.ok(err instanceof TypeError, `${err.name}: ${err.message}`)
    })
})
