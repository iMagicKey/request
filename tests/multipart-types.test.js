import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Request, stream } from '../src/index.js'
import { bounded, moduleUrl, rejection, respond, runChild, startServer } from './support/servers.js'

const parse = (record) => new Response(record.body, { headers: { 'content-type': record.headers['content-type'] } }).formData()
const ALL_BYTES = new Uint8Array(Array.from({ length: 256 }, (_v, i) => i))
const webStream = (...chunks) =>
    new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
        },
    })
const destroyedStream = () => {
    const destroyed = Readable.from([Buffer.from('REAL')])
    destroyed.destroy()
    return destroyed
}
const consumedStream = async () => {
    const consumed = Readable.from([Buffer.from('REAL')])
    for await (const _chunk of consumed) {
        /* consume */
    }
    return consumed
}

describe('multipart value types', () => {
    let server

    before(async () => {
        server = await startServer((_req, res) => respond(res))
    })

    after(() => server.close())

    const post = (formData, extra = {}) => Request(`${server.url}/upload`, { method: 'POST', formData, timeout: 5000, ...extra })

    describe('values that would be silently replaced are rejected', () => {
        const values = {
            Blob: () => new Blob(['x']),
            File: () => new File(['x'], 'a.txt'),
            ArrayBuffer: () => new ArrayBuffer(4),
            DataView: () => new DataView(new ArrayBuffer(4)),
            Uint16Array: () => new Uint16Array([1, 2]),
            Float64Array: () => new Float64Array([1.5]),
            Uint8ClampedArray: () => new Uint8ClampedArray([1]),
            'a plain object': () => ({ a: 1 }),
            'an array': () => ['a', 'b'],
            'a function': () => () => 1,
            'a symbol': () => Symbol('x'),
            null: () => null,
            undefined: () => undefined,
            'an object with no prototype': () => Object.create(null),
            'a destroyed stream': destroyedStream,
            'a consumed stream': consumedStream,
        }

        for (const [name, make] of Object.entries(values)) {
            it(`${name} rejects with a TypeError and sends nothing`, async () => {
                server.requests.length = 0
                const err = await rejection(post({ good: 'value', bad: await make() }))
                assert.ok(err instanceof TypeError, `${err.name}: ${err.message}`)
                assert.match(err.message, /formData field "bad"/)
                assert.equal(server.requests.length, 0)
            })
        }

        it('stream() throws the same TypeError', async () => {
            assert.throws(() => stream(`${server.url}/upload`, { method: 'POST', formData: { bad: new Blob(['x']) } }), (err) => err instanceof TypeError && /formData field "bad"/.test(err.message))
        })

        it('a locked web stream is rejected', async () => {
            const locked = webStream(ALL_BYTES)
            locked.getReader()
            const err = await rejection(post({ bad: locked }))
            assert.ok(err instanceof TypeError)
            assert.match(err.message, /formData field "bad".*locked/)
        })

        it('destroys the other streams of a rejected form', async () => {
            const sibling = new Readable({ read() {} })
            await rejection(post({ sibling, bad: new Blob(['x']) }))
            assert.equal(sibling.destroyed, true)
        })

        it('a failing sibling stream of a rejected form cannot crash the process', async () => {
            const script = `
                import fs from 'node:fs'
                import { Request } from ${JSON.stringify(moduleUrl)}
                const missing = fs.createReadStream('/nonexistent/imagic-request-synthetic')
                await Request('http://127.0.0.1:1/', { method: 'POST', formData: { missing, bad: new Blob(['x']) } }).catch((err) => console.log(err.name))
                await new Promise((resolve) => setTimeout(resolve, 50))
                console.log('survived')
            `
            const { code, stdout, stderr } = await runChild(script)
            assert.equal(code, 0, stderr)
            assert.match(stdout, /TypeError\nsurvived/)
        })
    })

    describe('formData itself must be a plain object', () => {
        const forms = {
            FormData: () => {
                const form = new FormData()
                form.append('a', 'b')
                return form
            },
            Map: () => new Map([['a', 'b']]),
            URLSearchParams: () => new URLSearchParams('a=b'),
            'an array': () => ['a', 'b'],
            'a string': () => 'abc',
            'a number': () => 5,
            true: () => true,
        }

        for (const [name, make] of Object.entries(forms)) {
            it(`${name} rejects with a TypeError and sends nothing`, async () => {
                server.requests.length = 0
                const err = await rejection(post(make()))
                assert.ok(err instanceof TypeError, `${err.name}: ${err.message}`)
                assert.match(err.message, /formData must be a plain object/)
                assert.equal(server.requests.length, 0)
            })
        }

        it('accepts an object with no prototype', async () => {
            const fields = Object.create(null)
            fields.a = 'b'
            server.requests.length = 0
            await bounded(post(fields))
            assert.equal((await parse(server.requests[0])).get('a'), 'b')
        })

        it('accepts a frozen object and leaves it alone', async () => {
            server.requests.length = 0
            const upload = webStream(ALL_BYTES)
            const fields = Object.freeze({ a: 'b', upload })
            await bounded(post(fields))
            assert.equal(fields.upload, upload)
            assert.equal((await parse(server.requests[0])).get('a'), 'b')
        })

        for (const empty of [undefined, null, '', 0, false]) {
            it(`still ignores ${JSON.stringify(empty) ?? 'undefined'}, as an absent form`, async () => {
                server.requests.length = 0
                await bounded(Request(`${server.url}/upload`, { method: 'POST', formData: empty, body: 'plain', timeout: 5000 }))
                assert.equal(server.requests[0].body.toString(), 'plain')
            })
        }
    })

    describe('supported values keep working', () => {
        it('numbers, booleans and bigints are sent as text', async () => {
            server.requests.length = 0
            await bounded(post({ zero: 0, count: 12, off: false, big: 10n }))
            const form = await parse(server.requests[0])
            assert.deepEqual([...form.entries()], [['zero', '0'], ['count', '12'], ['off', 'false'], ['big', '10']])
        })

        it('strings, Buffers and Uint8Arrays are plain fields', async () => {
            server.requests.length = 0
            await bounded(post({ text: 'x', buffer: Buffer.from('y'), bytes: new Uint8Array([122]) }))
            assert.deepEqual([...(await parse(server.requests[0])).entries()], [['text', 'x'], ['buffer', 'y'], ['bytes', 'z']])
        })

        it('a Node stream is a file part', async () => {
            server.requests.length = 0
            await bounded(post({ upload: Readable.from([Buffer.from(ALL_BYTES)]) }))
            const upload = (await parse(server.requests[0])).get('upload')
            assert.equal(upload.name, 'filename')
            assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), ALL_BYTES)
        })
    })

    describe('web ReadableStream', () => {
        it('is sent as a byte-identical file part', async () => {
            server.requests.length = 0
            await bounded(post({ before: 'x', upload: webStream(ALL_BYTES.subarray(0, 100), ALL_BYTES.subarray(100)), after: 'y' }))
            const form = await parse(server.requests[0])
            const upload = form.get('upload')
            assert.equal(upload.name, 'filename')
            assert.equal(upload.type, 'application/octet-stream')
            assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), ALL_BYTES)
            assert.equal(form.get('after'), 'y')
        })

        it('works through stream() too', async () => {
            server.requests.length = 0
            const res = await bounded(stream(`${server.url}/upload`, { method: 'POST', formData: { upload: webStream(ALL_BYTES) }, timeout: 5000 }))
            res.stream.resume()
            assert.deepEqual(new Uint8Array(await (await parse(server.requests[0])).get('upload').arrayBuffer()), ALL_BYTES)
        })

        it('rejects when the stream fails', async () => {
            const failing = new ReadableStream({
                pull() {
                    throw new Error('synthetic web stream failure')
                },
            })
            const err = await rejection(post({ upload: failing }))
            assert.match(err.message, /synthetic web stream failure/)
        })

        it('is cancelled when the request ends first', async () => {
            let cancelled = false
            const endless = new ReadableStream({
                pull() {
                    return new Promise(() => {})
                },
                cancel() {
                    cancelled = true
                },
            })
            await rejection(post({ upload: endless }, { deadline: 50, timeout: 0 }))
            const started = Date.now()
            while (!cancelled && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10))
            assert.equal(cancelled, true)
        })
    })
})
