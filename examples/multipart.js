// examples/multipart.js
// Demonstrates multipart/form-data upload using a local echo server.
import http from 'node:http'
import { Readable } from 'node:stream'
import Request from '../src/index.js'

// Spin up a minimal echo server that prints what it receives
const server = http.createServer((req, res) => {
    let chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
        const body = Buffer.concat(chunks)
        console.log('Server received Content-Type:', req.headers['content-type'])
        console.log('Server received body length:', body.length, 'bytes')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, bytes: body.length }))
    })
})

server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address()
    const url = `http://127.0.0.1:${port}/upload`

    // String fields
    try {
        const res = await Request(url, {
            method: 'POST',
            formData: {
                username: 'alice',
                message: 'Hello, world!',
            },
        })
        const json = JSON.parse(res.buffer.toString())
        console.log('Response:', json)
    } catch (err) {
        console.error('String fields error:', err)
    }

    // Stream field (simulates a file upload)
    try {
        const fileContent = Buffer.from('binary file content goes here')
        const readable = Readable.from(fileContent)
        // Attach a path so the library can infer the mime type
        readable.path = '/tmp/example.txt'

        const res = await Request(url, {
            method: 'POST',
            formData: {
                attachment: readable,
            },
        })
        const json = JSON.parse(res.buffer.toString())
        console.log('File upload response:', json)
    } catch (err) {
        console.error('File upload error:', err)
    }

    server.close()
})
