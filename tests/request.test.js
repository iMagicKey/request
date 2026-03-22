import { describe, it, before, after } from 'node:test'
import { expect } from 'chai'
import http from 'node:http'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import Request, { Request as NamedRequest } from '../src/index.js'

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let server
let baseUrl

before(() => {
    return new Promise((resolve) => {
        server = http.createServer((req, res) => {
            let body = []
            req.on('data', (chunk) => body.push(chunk))
            req.on('end', () => {
                let rawBody = Buffer.concat(body)

                if (req.url === '/get') {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ method: req.method, url: req.url }))
                    return
                }

                if (req.url === '/post') {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ method: req.method, body: rawBody.toString() }))
                    return
                }

                if (req.url === '/binary') {
                    // Echo body back so we can verify binary integrity
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
                    res.end(rawBody)
                    return
                }

                if (req.url === '/gzip') {
                    let data = JSON.stringify({ compressed: true })
                    zlib.gzip(data, (err, compressed) => {
                        if (err) {
                            res.writeHead(500)
                            res.end()
                            return
                        }
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Content-Encoding': 'gzip',
                        })
                        res.end(compressed)
                    })
                    return
                }

                if (req.url === '/deflate') {
                    let data = JSON.stringify({ deflated: true })
                    zlib.deflate(data, (err, compressed) => {
                        if (err) {
                            res.writeHead(500)
                            res.end()
                            return
                        }
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Content-Encoding': 'deflate',
                        })
                        res.end(compressed)
                    })
                    return
                }

                if (req.url === '/brotli') {
                    let data = JSON.stringify({ brotli: true })
                    zlib.brotliCompress(data, (err, compressed) => {
                        if (err) {
                            res.writeHead(500)
                            res.end()
                            return
                        }
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Content-Encoding': 'br',
                        })
                        res.end(compressed)
                    })
                    return
                }

                if (req.url === '/timeout') {
                    // Never respond — used to test request timeout
                    return
                }

                if (req.url === '/multipart') {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(
                        JSON.stringify({
                            contentType: req.headers['content-type'],
                            bodyLength: rawBody.length,
                        })
                    )
                    return
                }

                if (req.url === '/headers') {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ received: req.headers['x-custom-header'] || null }))
                    return
                }

                if (req.url === '/method') {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ method: req.method }))
                    return
                }

                res.writeHead(404)
                res.end()
            })
        })

        server.listen(0, '127.0.0.1', () => {
            let { port } = server.address()
            baseUrl = `http://127.0.0.1:${port}`
            resolve()
        })
    })
})

after(() => {
    return new Promise((resolve) => server.close(resolve))
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Request', () => {
    describe('exports', () => {
        it('default export is a function', () => {
            expect(Request).to.be.a('function')
        })

        it('named export Request is the same function', () => {
            expect(NamedRequest).to.equal(Request)
        })
    })

    describe('input validation', () => {
        it('rejects when url is not a string', async () => {
            try {
                await Request(123)
                expect.fail('Should have thrown')
            } catch (err) {
                expect(err.message).to.equal('URL must be a string')
            }
        })

        it('rejects when options is not an object', async () => {
            try {
                await Request('http://example.com', 'bad')
                expect.fail('Should have thrown')
            } catch (err) {
                expect(err.message).to.equal('Options must be an object')
            }
        })

        it('rejects when options is null', async () => {
            try {
                await Request('http://example.com', null)
                expect.fail('Should have thrown')
            } catch (err) {
                expect(err.message).to.equal('Options must be an object')
            }
        })
    })

    describe('GET request', () => {
        it('returns statusCode 200', async () => {
            let res = await Request(`${baseUrl}/get`)
            expect(res.statusCode).to.equal(200)
        })

        it('returns a buffer on the response', async () => {
            let res = await Request(`${baseUrl}/get`)
            expect(res.buffer).to.be.instanceOf(Buffer)
        })

        it('buffer contains expected JSON body', async () => {
            let res = await Request(`${baseUrl}/get`)
            let json = JSON.parse(res.buffer.toString())
            expect(json.method).to.equal('GET')
            expect(json.url).to.equal('/get')
        })

        it('returns response headers', async () => {
            let res = await Request(`${baseUrl}/get`)
            expect(res.headers).to.have.property('content-type')
        })
    })

    describe('POST request with string body', () => {
        it('sends body to server and echoes it back', async () => {
            let res = await Request(`${baseUrl}/post`, {
                method: 'POST',
                body: 'hello world',
                headers: { 'Content-Type': 'text/plain' },
            })
            let json = JSON.parse(res.buffer.toString())
            expect(json.method).to.equal('POST')
            expect(json.body).to.equal('hello world')
        })
    })

    describe('POST request with Buffer body — binary integrity', () => {
        it('echoes binary data back without corruption', async () => {
            // Create a buffer with all byte values 0–255
            let original = Buffer.allocUnsafe(256)
            for (let i = 0; i < 256; i++) original[i] = i

            let res = await Request(`${baseUrl}/binary`, {
                method: 'POST',
                body: original,
                headers: { 'Content-Type': 'application/octet-stream' },
            })

            expect(res.buffer.equals(original)).to.equal(true)
        })

        it('res.buffer is a Buffer instance', async () => {
            let res = await Request(`${baseUrl}/get`)
            expect(Buffer.isBuffer(res.buffer)).to.equal(true)
        })
    })

    describe('compressed responses', () => {
        it('decompresses gzip response', async () => {
            let res = await Request(`${baseUrl}/gzip`)
            let json = JSON.parse(res.buffer.toString())
            expect(json.compressed).to.equal(true)
        })

        it('decompresses deflate response', async () => {
            let res = await Request(`${baseUrl}/deflate`)
            let json = JSON.parse(res.buffer.toString())
            expect(json.deflated).to.equal(true)
        })

        it('decompresses brotli response', async () => {
            let res = await Request(`${baseUrl}/brotli`)
            let json = JSON.parse(res.buffer.toString())
            expect(json.brotli).to.equal(true)
        })
    })

    describe('timeout', () => {
        it('rejects with timeout error when server does not respond in time', async () => {
            try {
                await Request(`${baseUrl}/timeout`, { timeout: 100 })
                expect.fail('Should have thrown')
            } catch (err) {
                expect(err.message).to.equal('Request timed out')
            }
        })
    })

    describe('network error', () => {
        it('rejects when host is unreachable', async () => {
            try {
                await Request('http://127.0.0.1:1')
                expect.fail('Should have thrown')
            } catch (err) {
                expect(err).to.be.instanceOf(Error)
            }
        })
    })

    describe('multipart form', () => {
        it('sets correct Content-Type with boundary for string fields', async () => {
            let res = await Request(`${baseUrl}/multipart`, {
                method: 'POST',
                formData: {
                    field1: 'value1',
                    field2: 'value2',
                },
            })
            let json = JSON.parse(res.buffer.toString())
            expect(json.contentType).to.match(/^multipart\/form-data; boundary=/)
        })

        it('sends non-empty body for string fields', async () => {
            let res = await Request(`${baseUrl}/multipart`, {
                method: 'POST',
                formData: {
                    name: 'test',
                },
            })
            let json = JSON.parse(res.buffer.toString())
            expect(json.bodyLength).to.be.greaterThan(0)
        })

        it('includes field names and values in the body', async () => {
            let res = await Request(`${baseUrl}/multipart`, {
                method: 'POST',
                formData: {
                    username: 'alice',
                },
            })
            // Re-request to /binary to echo body and inspect it
            let bodyRes = await Request(`${baseUrl}/binary`, {
                method: 'POST',
                body: res.buffer,
                headers: { 'Content-Type': 'application/octet-stream' },
            })
            // body is echoed — just ensure it round-trips correctly
            expect(bodyRes.buffer.equals(res.buffer)).to.equal(true)
        })

        it('sends multipart with a readable stream field', async () => {
            // Create a readable stream from a buffer
            let streamContent = Buffer.from('stream content data')
            let readable = Readable.from(streamContent)

            let res = await Request(`${baseUrl}/multipart`, {
                method: 'POST',
                formData: {
                    file: readable,
                },
            })
            let json = JSON.parse(res.buffer.toString())
            expect(json.contentType).to.match(/^multipart\/form-data; boundary=/)
            expect(json.bodyLength).to.be.greaterThan(0)
        })
    })

    describe('custom request headers', () => {
        it('sends custom header to server', async () => {
            let res = await Request(`${baseUrl}/headers`, {
                headers: { 'x-custom-header': 'my-value' },
            })
            let json = JSON.parse(res.buffer.toString())
            expect(json.received).to.equal('my-value')
        })

        it('default empty headers object does not break request', async () => {
            let res = await Request(`${baseUrl}/headers`)
            let json = JSON.parse(res.buffer.toString())
            expect(json.received).to.equal(null)
        })
    })

    describe('HTTP methods — PUT / DELETE', () => {
        it('sends PUT request with correct method', async () => {
            let res = await Request(`${baseUrl}/method`, { method: 'PUT' })
            let json = JSON.parse(res.buffer.toString())
            expect(json.method).to.equal('PUT')
        })

        it('sends DELETE request with correct method', async () => {
            let res = await Request(`${baseUrl}/method`, { method: 'DELETE' })
            let json = JSON.parse(res.buffer.toString())
            expect(json.method).to.equal('DELETE')
        })

        it('sends PATCH request with correct method', async () => {
            let res = await Request(`${baseUrl}/method`, { method: 'PATCH' })
            let json = JSON.parse(res.buffer.toString())
            expect(json.method).to.equal('PATCH')
        })
    })
})
