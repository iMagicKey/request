import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Request, stream } from '../src/index.js'
import { bounded, moduleUrl, rejection, respond, runChild, startRawServer, startServer } from './support/servers.js'

const MISSING = '/nonexistent/imagic-request-synthetic'
const WAIT_MS = 5000
const never = () => new Readable({ read() {} })
const isClosed = (s) => (s.closed ? Promise.resolve() : bounded(once(s, 'close'), WAIT_MS))

describe('multipart field streams', () => {
    let dir
    let bigFile
    let server
    let silent

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagic-request-form-'))
        bigFile = path.join(dir, 'big.bin')
        fs.writeFileSync(bigFile, Buffer.alloc(5 * 1024 * 1024, 7))
        server = await startServer((_req, res) => respond(res))
        silent = await startRawServer()
    })

    after(async () => {
        await Promise.all([server.close(), silent.close()])
        fs.rmSync(dir, { recursive: true, force: true })
    })

    /** Run a client in a real process with no error handlers of its own: an uncaught error changes the exit code. */
    async function inChild(body) {
        const script = `
            import fs from 'node:fs'
            import { Readable } from 'node:stream'
            import { Request, stream } from ${JSON.stringify(moduleUrl)}
            const URL_ = ${JSON.stringify(server.url)}
            const HOLD = ${JSON.stringify(silent.url)}
            const BIG = ${JSON.stringify(bigFile)}
            const MISSING = ${JSON.stringify(MISSING)}
            const never = () => new Readable({ read() {} })
            const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            ${body}
            console.log('survived')
        `
        const result = await runChild(script)
        assert.equal(result.code, 0, `the process must not die. stderr: ${result.stderr}`)
        assert.match(result.stdout, /survived/)
        return result.stdout
    }

    describe('in a real process', () => {
        it('a stream that errors before its field is reached rejects the request', async () => {
            const stdout = await inChild(`
                try {
                    await Request(URL_, { method: 'POST', formData: { a: fs.createReadStream(BIG), b: fs.createReadStream(MISSING) } })
                    console.log('resolved')
                } catch (err) {
                    console.log('caught', err.code)
                }
            `)
            assert.match(stdout, /caught ENOENT/)
        })

        it('a later field failing behind a text field rejects the request', async () => {
            const stdout = await inChild(`
                await Request(URL_, { method: 'POST', formData: { a: 'text', b: fs.createReadStream(MISSING) } }).catch((err) => console.log('caught', err.code))
            `)
            assert.match(stdout, /caught ENOENT/)
        })

        it('stream() rejects too', async () => {
            const stdout = await inChild(`
                await stream(HOLD, { method: 'POST', timeout: 0, formData: { a: never(), b: fs.createReadStream(MISSING) } }).catch((err) => console.log('caught', err.code))
            `)
            assert.match(stdout, /caught ENOENT/)
        })

        it('a late error on an unreached field after an abort is harmless', async () => {
            await inChild(`
                const later = never()
                const controller = new AbortController()
                setTimeout(() => controller.abort(), 20)
                await Request(HOLD, { method: 'POST', timeout: 0, signal: controller.signal, formData: { a: never(), b: later } }).catch(() => {})
                later.destroy(new Error('late'))
                later.emit('error', new Error('later still'))
                await pause(50)
            `)
        })

        it('a failing stream is harmless when the options are invalid', async () => {
            const stdout = await inChild(`
                await Request(URL_, { method: 'POST', sensitiveHeaders: 'invalid', formData: { b: fs.createReadStream(MISSING) } }).catch((err) => console.log('caught', err.message))
                await pause(50)
            `)
            assert.match(stdout, /caught sensitiveHeaders must be an array/)
        })

        it('a failing stream is harmless when the signal has already aborted', async () => {
            await inChild(`
                await Request(URL_, { method: 'POST', signal: AbortSignal.abort(), formData: { b: fs.createReadStream(MISSING) } }).catch(() => {})
                await pause(50)
            `)
        })

        it('a failing stream is harmless when stream() throws on invalid options', async () => {
            await inChild(`
                try {
                    stream(URL_, { method: 'POST', body: { invalid: true }, formData: { b: fs.createReadStream(MISSING) } })
                } catch {
                    console.log('thrown')
                }
                await pause(50)
            `)
        })
    })

    describe('rejections', () => {
        it('rejects with the error of a stream failing part-way, and destroys the others', async () => {
            const failing = never()
            failing.push('part')
            const unreached = never()
            setTimeout(() => failing.destroy(new Error('synthetic mid-stream failure')), 20)
            const err = await rejection(Request(server.url, { method: 'POST', formData: { a: failing, b: unreached }, timeout: 0 }), WAIT_MS)
            assert.match(err.message, /synthetic mid-stream failure/)
            await isClosed(unreached)
            assert.equal(unreached.destroyed, true)
        })

        it('rejects when a stream is destroyed without an error, even with no timeout', async () => {
            const killed = never()
            killed.push('part')
            setTimeout(() => killed.destroy(), 20)
            const err = await rejection(Request(server.url, { method: 'POST', formData: { a: killed }, timeout: 0 }), WAIT_MS)
            assert.match(err.message, /closed before it ended/)
        })

        it('stream() rejects when a stream is destroyed without an error', async () => {
            const killed = never()
            killed.push('part')
            setTimeout(() => killed.destroy(), 20)
            const err = await rejection(stream(silent.url, { method: 'POST', formData: { a: killed }, timeout: 0 }), WAIT_MS)
            assert.match(err.message, /closed before it ended/)
        })
    })

    describe('when the request ends first', () => {
        it('an abort destroys every field stream and releases the file', async () => {
            const file = fs.createReadStream(bigFile)
            const unreached = never()
            const controller = new AbortController()
            setTimeout(() => controller.abort(), 20)
            const err = await rejection(Request(silent.url, { method: 'POST', formData: { a: file, b: unreached }, signal: controller.signal, timeout: 0 }), WAIT_MS)
            assert.equal(err.name, 'AbortError')
            await isClosed(file)
            await isClosed(unreached)
            assert.equal(file.destroyed, true)
            assert.equal(unreached.destroyed, true)
        })

        it('a reset connection destroys every field stream', async () => {
            const reset = await startRawServer((socket) => socket.destroy())
            try {
                const first = never()
                first.push('part')
                const unreached = never()
                await rejection(Request(reset.url, { method: 'POST', formData: { a: first, b: unreached }, timeout: 0 }), WAIT_MS)
                await isClosed(first)
                await isClosed(unreached)
            } finally {
                await reset.close()
            }
        })

        it('a deadline destroys every field stream', async () => {
            const unreached = never()
            await rejection(Request(silent.url, { method: 'POST', formData: { a: never(), b: unreached }, deadline: 100, timeout: 0 }), WAIT_MS)
            await isClosed(unreached)
        })

        it('invalid options destroy the field streams', async () => {
            const field = never()
            await rejection(Request(server.url, { method: 'POST', sensitiveHeaders: 'invalid', formData: { a: field } }), WAIT_MS)
            await isClosed(field)
        })

        it('an already aborted signal destroys the field streams', async () => {
            const field = never()
            await rejection(Request(server.url, { method: 'POST', signal: AbortSignal.abort(), formData: { a: field } }), WAIT_MS)
            await isClosed(field)
        })

        it('a stream() failure destroys the field streams', async () => {
            const field = never()
            await rejection(stream('not a url', { method: 'POST', formData: { a: field } }), WAIT_MS)
            await isClosed(field)
        })
    })

    it('still sends several file streams intact (positive control)', async () => {
        server.requests.length = 0
        const res = await bounded(Request(server.url, { method: 'POST', formData: { a: fs.createReadStream(bigFile), note: 'text', b: Readable.from([Buffer.from('second')]) }, timeout: 0 }), WAIT_MS)
        assert.equal(res.statusCode, 200)
        const [record] = server.requests
        const form = await new Response(record.body, { headers: { 'content-type': record.headers['content-type'] } }).formData()
        assert.equal(form.get('a').size, 5 * 1024 * 1024)
        assert.equal(form.get('note'), 'text')
        assert.equal(await form.get('b').text(), 'second')
    })
})
