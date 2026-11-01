import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { Request, stream } from '../src/index.js'
import { bounded, rejection, respond, startServer } from './support/servers.js'

/** A minimal loopback DNS server: A records for *.test point at 127.0.0.1, anything else is NXDOMAIN. */
async function startDnsServer() {
    const queries = []
    const socket = dgram.createSocket('udp4')
    socket.on('message', (query, rinfo) => {
        let end = 12
        const labels = []
        while (query[end] !== 0) {
            labels.push(query.subarray(end + 1, end + 1 + query[end]).toString())
            end += query[end] + 1
        }
        const name = labels.join('.')
        queries.push(name)
        const question = query.subarray(12, end + 5)
        const found = name.endsWith('.test') && !name.startsWith('missing.')
        const header = Buffer.alloc(12)
        query.copy(header, 0, 0, 2)
        header.writeUInt16BE(found ? 0x8180 : 0x8183, 2)
        header.writeUInt16BE(1, 4)
        header.writeUInt16BE(found ? 1 : 0, 6)
        const answer = found ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0)
        socket.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address)
    })
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))
    return {
        address: `127.0.0.1:${socket.address().port}`,
        queries,
        close: () => new Promise((resolve) => socket.close(resolve)),
    }
}

describe('dns option', () => {
    let server
    let dnsServer

    before(async () => {
        server = await startServer((_req, res) => respond(res, 200, {}, 'resolved'))
        dnsServer = await startDnsServer()
    })

    after(async () => {
        await Promise.all([server.close(), dnsServer.close()])
    })

    it('Request() connects to the address returned by the configured server', async () => {
        dnsServer.queries.length = 0
        const res = await bounded(Request(`http://service.test:${server.port}/`, { dns: dnsServer.address, timeout: 5000 }))
        assert.equal(res.buffer.toString(), 'resolved')
        assert.deepEqual(dnsServer.queries, ['service.test'])
    })

    it('stream() connects to the address returned by the configured server', async () => {
        dnsServer.queries.length = 0
        const res = await bounded(stream(`http://stream.test:${server.port}/`, { dns: dnsServer.address, timeout: 5000 }))
        res.stream.resume()
        assert.equal(res.statusCode, 200)
        assert.deepEqual(dnsServer.queries, ['stream.test'])
    })

    it('also supports a lookup called without all: true', async () => {
        const res = await bounded(Request(`http://single.test:${server.port}/`, { dns: dnsServer.address, autoSelectFamily: false, timeout: 5000 }))
        assert.equal(res.buffer.toString(), 'resolved')
    })

    it('rejects when the configured server has no such name', async () => {
        const err = await rejection(Request(`http://missing.test:${server.port}/`, { dns: dnsServer.address, timeout: 5000 }))
        assert.equal(err.code, 'ENOTFOUND')
    })

    it('does not modify the caller options', async () => {
        const options = { dns: dnsServer.address, timeout: 5000 }
        await bounded(Request(`http://service.test:${server.port}/`, options))
        assert.deepEqual(options, { dns: dnsServer.address, timeout: 5000 })
    })
})
