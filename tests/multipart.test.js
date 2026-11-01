import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Request } from '../src/index.js'
import createMultipartForm from '../src/modules/multipartform.js'
import { bounded, rejection, startServer } from './support/servers.js'

/** Split received multipart bytes on the declared boundary, without decoding part bodies. */
function parseMultipart(contentType, body) {
    const match = /^multipart\/form-data; boundary=(.+)$/.exec(contentType)
    assert.ok(match, `unexpected Content-Type: ${contentType}`)
    const delimiter = Buffer.from(`--${match[1]}`)

    assert.equal(body.indexOf(delimiter), 0, 'body must start with the delimiter')
    const parts = []
    let cursor = delimiter.length
    for (;;) {
        if (body.subarray(cursor, cursor + 2).toString() === '--') break
        assert.equal(body.subarray(cursor, cursor + 2).toString(), '\r\n', 'delimiter must be followed by CRLF')
        cursor += 2
        const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), cursor)
        assert.notEqual(next, -1, 'part must be terminated by a delimiter')
        const part = body.subarray(cursor, next)
        const headerEnd = part.indexOf('\r\n\r\n')
        assert.notEqual(headerEnd, -1, 'part must contain a header block')
        parts.push({ headers: part.subarray(0, headerEnd).toString('latin1').split('\r\n'), body: part.subarray(headerEnd + 4) })
        cursor = next + 2 + delimiter.length
    }
    return parts
}

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_v, i) => i))
const TEXT_FIELD = 'plain value'

describe('multipart encoding', () => {
    let server

    before(async () => {
        server = await startServer((_req, res) => {
            res.writeHead(200)
            res.end('ok')
        })
    })

    after(() => server.close())

    async function send(formData) {
        server.requests.length = 0
        const res = await bounded(Request(`${server.url}/upload`, { method: 'POST', formData, timeout: 5000 }))
        assert.equal(res.statusCode, 200)
        const record = server.requests[0]
        return { record, parts: parseMultipart(record.headers['content-type'], record.body) }
    }

    /** The same bytes through Node's own multipart parser, as an independent reading of the wire format. */
    function nativeParse(record) {
        return new Response(record.body, { headers: { 'content-type': record.headers['content-type'] } }).formData()
    }

    describe('Buffer values', () => {
        it('arrive byte-identical for all 256 byte values', async () => {
            const { parts } = await send({ data: ALL_BYTES })
            assert.equal(parts.length, 1)
            assert.deepEqual(parts[0].body, ALL_BYTES)
        })

        it('arrive byte-identical when they contain a boundary-like sequence', async () => {
            const payload = Buffer.concat([Buffer.from('before\r\n--'), ALL_BYTES, Buffer.from('\r\n-----abc\r\n--'), ALL_BYTES, Buffer.from('\r\n--')])
            const { parts } = await send({ first: payload, second: 'after' })
            assert.equal(parts.length, 2)
            assert.deepEqual(parts[0].body, payload)
            assert.equal(parts[1].body.toString(), 'after')
        })

        it('arrive byte-identical when the value is invalid UTF-8', async () => {
            const payload = Buffer.from([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80])
            const { parts } = await send({ data: payload })
            assert.deepEqual(parts[0].body, payload)
        })

        it('arrive empty for an empty Buffer', async () => {
            const { parts } = await send({ data: Buffer.alloc(0), next: 'x' })
            assert.equal(parts[0].body.length, 0)
            assert.equal(parts[1].body.toString(), 'x')
        })

        it('stay plain fields, as documented: no filename and no Content-Type', async () => {
            const { parts, record } = await send({ data: Buffer.from('abc') })
            assert.deepEqual(parts[0].headers, ['Content-Disposition: form-data; name="data"'])
            const form = await nativeParse(record)
            assert.equal(form.get('data'), 'abc')
        })

        it('also applies to a Uint8Array', async () => {
            const { parts } = await send({ data: new Uint8Array(ALL_BYTES) })
            assert.deepEqual(parts[0].body, ALL_BYTES)
        })

        it('respects the Buffer view rather than its backing store', async () => {
            const { parts } = await send({ data: ALL_BYTES.subarray(10, 20) })
            assert.deepEqual(parts[0].body, ALL_BYTES.subarray(10, 20))
        })
    })

    describe('other values keep their documented shape', () => {
        it('sends a string as UTF-8 text', async () => {
            const { parts, record } = await send({ text: 'héllo \u{1F600}' })
            assert.deepEqual(parts[0].headers, ['Content-Disposition: form-data; name="text"'])
            assert.equal(parts[0].body.toString('utf8'), 'héllo \u{1F600}')
            assert.equal((await nativeParse(record)).get('text'), 'héllo \u{1F600}')
        })

        it('sends zero and empty string values', async () => {
            const { parts } = await send({ zero: 0, empty: '' })
            assert.equal(parts[0].body.toString(), '0')
            assert.equal(parts[1].body.toString(), '')
        })

        it('sends a stream without a path as a file named "filename"', async () => {
            const { parts } = await send({ upload: Readable.from([ALL_BYTES]) })
            assert.deepEqual(parts[0].headers, ['Content-Disposition: form-data; name="upload"; filename="filename"', 'Content-Type: application/octet-stream'])
            assert.deepEqual(parts[0].body, ALL_BYTES)
        })

        it('sends a real file stream byte-identical, with name and type from its path', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagic-request-multipart-'))
            try {
                const file = path.join(dir, 'chart.png')
                fs.writeFileSync(file, ALL_BYTES)
                const { parts, record } = await send({ upload: fs.createReadStream(file), note: TEXT_FIELD })
                assert.deepEqual(parts[0].headers, ['Content-Disposition: form-data; name="upload"; filename="chart.png"', 'Content-Type: image/png'])
                assert.deepEqual(parts[0].body, ALL_BYTES)
                const form = await nativeParse(record)
                assert.equal(form.get('upload').name, 'chart.png')
                assert.equal(form.get('note'), TEXT_FIELD)
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })

        it('gives an unrecognised or inherited-looking extension the default type', async () => {
            const upload = Readable.from([Buffer.from('x')])
            upload.path = '/tmp/report.constructor'
            const { parts } = await send({ upload })
            assert.equal(parts[0].headers[1], 'Content-Type: application/octet-stream')
        })
    })

    describe('injection through names', () => {
        const INJECTED = 'x"; filename="evil.txt"\r\nContent-Type: text/evil\r\n\r\ninjected\r\n'
        const ESCAPED = 'x%22; filename=%22evil.txt%22%0D%0AContent-Type: text/evil%0D%0A%0D%0Ainjected%0D%0A'

        it('escapes quotes and CRLF in a text field name', async () => {
            const { parts, record } = await send({ [INJECTED]: TEXT_FIELD })
            assert.equal(parts.length, 1)
            assert.deepEqual(parts[0].headers, [`Content-Disposition: form-data; name="${ESCAPED}"`])
            assert.equal(parts[0].body.toString(), TEXT_FIELD)
            // Node's parser undoes the escaping: exactly one field, under the original name, is what proves no injection.
            const form = await nativeParse(record)
            assert.deepEqual([...form.keys()], [INJECTED])
            assert.equal(form.get(INJECTED), TEXT_FIELD)
        })

        it('escapes quotes and CRLF in a Buffer field name', async () => {
            const { parts } = await send({ [INJECTED]: Buffer.from(TEXT_FIELD) })
            assert.deepEqual(parts[0].headers, [`Content-Disposition: form-data; name="${ESCAPED}"`])
        })

        it('escapes quotes and CRLF in a stream field name', async () => {
            const { parts } = await send({ [INJECTED]: Readable.from([Buffer.from(TEXT_FIELD)]) })
            assert.equal(parts[0].headers[0], `Content-Disposition: form-data; name="${ESCAPED}"; filename="filename"`)
        })

        it('escapes quotes and CRLF in a filename taken from the stream path', async () => {
            const upload = Readable.from([Buffer.from(TEXT_FIELD)])
            const filename = 'x"; name="evil"\r\nX-Injected: yes\r\n\r\ninjected.txt'
            upload.path = `/uploads/${filename}`
            const { parts, record } = await send({ upload })
            assert.equal(parts.length, 1)
            assert.equal(parts[0].headers.length, 2, `no injected part headers: ${parts[0].headers}`)
            assert.equal(parts[0].headers[0], 'Content-Disposition: form-data; name="upload"; filename="x%22; name=%22evil%22%0D%0AX-Injected: yes%0D%0A%0D%0Ainjected.txt"')
            assert.equal(parts[0].headers[1], 'Content-Type: text/plain')
            assert.equal(parts[0].body.toString(), TEXT_FIELD)
            const form = await nativeParse(record)
            assert.deepEqual([...form.keys()], ['upload'])
            assert.equal(form.get('upload').name, filename)
        })

        it('escapes a lone CR and a lone LF', async () => {
            const { parts } = await send({ 'a\rb\nc': TEXT_FIELD })
            assert.deepEqual(parts[0].headers, ['Content-Disposition: form-data; name="a%0Db%0Ac"'])
        })

        it('produces the same field name encoding as native FormData', async () => {
            const name = 'quote"crlf\r\nend'
            const { parts } = await send({ [name]: TEXT_FIELD })
            const native = new FormData()
            native.append(name, TEXT_FIELD)
            const nativeBody = await new Response(native).text()
            assert.ok(nativeBody.includes(parts[0].headers[0]), `native encoding differs from ${parts[0].headers[0]}:\n${nativeBody}`)
        })

        it('produces the same filename encoding as native FormData', async () => {
            const filename = 'quote"cr\rlf\ncrlf\r\nend.bin'
            const upload = Readable.from([Buffer.from('x')])
            upload.path = filename
            const { parts } = await send({ upload })
            const native = new FormData()
            native.append('upload', new Blob(['x']), filename)
            const nativeBody = await new Response(native).text()
            assert.ok(nativeBody.includes(parts[0].headers[0]), `native encoding differs from ${parts[0].headers[0]}:\n${nativeBody}`)
        })

        it('leaves ordinary names untouched', async () => {
            const { parts } = await send({ 'chat_id': '1', 'naïve name%22': 'x' })
            assert.equal(parts[0].headers[0], 'Content-Disposition: form-data; name="chat_id"')
            assert.equal(Buffer.from(parts[1].headers[0], 'latin1').toString('utf8'), 'Content-Disposition: form-data; name="naïve name%22"')
        })
    })

    describe('boundary', () => {
        it('differs between forms and is not derived from Math.random', () => {
            const original = Math.random
            Math.random = () => 0
            try {
                const first = createMultipartForm({ a: 'b' }).boundary
                const second = createMultipartForm({ a: 'b' }).boundary
                assert.notEqual(first, second)
                assert.match(first, /^---[0-9a-f]{24}$/)
            } finally {
                Math.random = original
            }
        })
    })

    it('overrides a caller-supplied Content-Type header so the boundary always matches', async () => {
        server.requests.length = 0
        const headers = { 'content-type': 'multipart/form-data; boundary=attacker' }
        await bounded(Request(`${server.url}/upload`, { method: 'POST', headers, formData: { a: 'b' }, timeout: 5000 }))
        assert.match(server.requests[0].headers['content-type'], /boundary=---[0-9a-f]{24}$/)
        parseMultipart(server.requests[0].headers['content-type'], server.requests[0].body)
        assert.deepEqual(headers, { 'content-type': 'multipart/form-data; boundary=attacker' })
    })

    it('rejects when a field stream fails', async () => {
        const upload = new Readable({
            read() {
                this.destroy(new Error('synthetic read failure'))
            },
        })
        const err = await rejection(Request(`${server.url}/upload`, { method: 'POST', formData: { upload }, timeout: 5000 }))
        assert.match(err.message, /synthetic read failure/)
    })
})
