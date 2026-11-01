import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { Request } from '../src/index.js'
import { assertNotReceived, bounded, rejection, respond, startServer } from './support/servers.js'

const SECRET = 'Sentinel-Secret-7f3a'

const HEADER_SPELLINGS = [
    'Authorization',
    'authorization',
    'AUTHORIZATION',
    'Cookie',
    'cookie',
    'COOKIE',
    'Proxy-Authorization',
    'proxy-authorization',
    'PROXY-AUTHORIZATION',
    'X-Api-Key',
    'x-api-key',
    'X-API-KEY',
    'X-Auth-Token',
    'x-auth-token',
    'X-AUTH-TOKEN',
]

describe('redirect credential handling', () => {
    let a
    let b

    before(async () => {
        const route = (other) => (req, res) => {
            const target = new URL(req.url, 'http://x').searchParams.get('to')
            if (target) {
                const status = Number(new URL(req.url, 'http://x').searchParams.get('status')) || 302
                respond(res, status, { Location: target.replace('{a}', a.url).replace('{b}', b.url) }, '')
                return
            }
            if (req.url.startsWith('/fail')) {
                respond(res, 503)
                return
            }
            respond(res, 200, {}, other)
        }
        a = await startServer(route('A'))
        b = await startServer(route('B'))
    })

    after(async () => {
        await Promise.all([a.close(), b.close()])
    })

    const reset = () => {
        a.requests.length = 0
        b.requests.length = 0
    }
    const via = (to, status = 302) => `/start?status=${status}&to=${encodeURIComponent(to)}`

    for (const header of HEADER_SPELLINGS) {
        it(`strips ${header} on a cross-origin redirect`, async () => {
            reset()
            const res = await Request(`${a.url}${via(`${b.url}/final`)}`, { headers: { [header]: SECRET }, timeout: 5000 })
            assert.equal(res.statusCode, 200)
            assert.equal(res.buffer.toString(), 'B')
            assert.equal(a.requests[0].headers[header.toLowerCase()], SECRET, 'first origin must receive the credential')
            assert.equal(b.requests.length, 1)
            assertNotReceived(b.requests[0], SECRET, 'second origin')
        })
    }

    it('strips several spellings of the same credential sent together', async () => {
        reset()
        await Request(`${a.url}${via(`${b.url}/final`)}`, {
            headers: { Authorization: `${SECRET}-1`, AUTHORIZATION: `${SECRET}-2`, authorization: `${SECRET}-3`, cookie: `${SECRET}-4`, Cookie: `${SECRET}-5` },
            timeout: 5000,
        })
        assertNotReceived(b.requests[0], SECRET, 'second origin')
    })

    it('keeps non-sensitive headers on a cross-origin redirect', async () => {
        reset()
        await Request(`${a.url}${via(`${b.url}/final`)}`, { headers: { 'X-Trace': 'keep-me', Authorization: SECRET }, timeout: 5000 })
        assert.equal(b.requests[0].headers['x-trace'], 'keep-me')
    })

    it('strips an explicit Host header on a cross-origin redirect', async () => {
        reset()
        await Request(`${a.url}${via(`${b.url}/final`)}`, { headers: { Host: 'sentinel-host.example' }, timeout: 5000 })
        assert.equal(a.requests[0].headers.host, 'sentinel-host.example')
        assert.equal(b.requests[0].headers.host, `127.0.0.1:${b.port}`)
    })

    it('drops the auth option on a cross-origin redirect', async () => {
        reset()
        await Request(`${a.url}${via(`${b.url}/final`)}`, { auth: `user:${SECRET}`, timeout: 5000 })
        assert.match(a.requests[0].headers.authorization, /^Basic /)
        assert.equal(b.requests[0].headers.authorization, undefined)
    })

    it('does not carry URL userinfo to a second origin', async () => {
        reset()
        await Request(`http://user:${SECRET}@127.0.0.1:${a.port}${via(`${b.url}/final`)}`, { timeout: 5000 })
        assert.match(a.requests[0].headers.authorization, /^Basic /)
        assert.equal(b.requests[0].headers.authorization, undefined)
    })

    it('keeps credentials stripped when a chain returns to the original origin (A -> B -> A)', async () => {
        reset()
        const backToA = `${a.url}/final`
        const res = await Request(`${a.url}${via(`${b.url}${via(backToA)}`)}`, {
            headers: {
                Authorization: SECRET,
                authorization: SECRET,
                Cookie: SECRET,
                'Proxy-Authorization': SECRET,
                Host: 'sentinel-host.example',
                'X-Api-Key': SECRET,
            },
            auth: `user:${SECRET}`,
            timeout: 5000,
        })
        assert.equal(res.buffer.toString(), 'A')
        assert.equal(a.requests.length, 2)
        assert.equal(b.requests.length, 1)
        assert.equal(a.requests[0].headers['x-api-key'], SECRET)
        assertNotReceived(b.requests[0], SECRET, 'second origin')
        assertNotReceived(a.requests[1], SECRET, 'first origin after the chain left it')
        assert.equal(a.requests[1].headers.authorization, undefined)
        assert.equal(a.requests[1].headers.host, `127.0.0.1:${a.port}`)
    })

    it('keeps credentials on a same-origin redirect (positive control)', async () => {
        reset()
        const headers = { Authorization: SECRET, COOKIE: SECRET, 'x-api-key': SECRET, Host: 'sentinel-host.example' }
        await Request(`${a.url}${via('/final')}`, { headers, timeout: 5000 })
        assert.equal(a.requests.length, 2)
        assert.equal(a.requests[1].url, '/final')
        assert.equal(a.requests[1].headers.authorization, SECRET)
        assert.equal(a.requests[1].headers.cookie, SECRET)
        assert.equal(a.requests[1].headers['x-api-key'], SECRET)
        assert.equal(a.requests[1].headers.host, 'sentinel-host.example')
    })

    it('keeps the auth option on a same-origin redirect (positive control)', async () => {
        reset()
        await Request(`${a.url}${via('/final')}`, { auth: `user:${SECRET}`, timeout: 5000 })
        assert.match(a.requests[1].headers.authorization, /^Basic /)
    })

    it('treats a different port on the same host as cross-origin', async () => {
        reset()
        assert.notEqual(a.port, b.port)
        await Request(`${a.url}${via(`http://127.0.0.1:${b.port}/final`)}`, { headers: { Cookie: SECRET }, timeout: 5000 })
        assertNotReceived(b.requests[0], SECRET, 'different port')
    })

    it('treats a different host name for the same server and port as cross-origin', async () => {
        reset()
        const res = await Request(`${a.url}${via(`http://localhost:${a.port}/final`)}`, { headers: { Cookie: SECRET, Authorization: SECRET }, timeout: 5000 })
        assert.equal(res.statusCode, 200)
        assert.equal(a.requests.length, 2, 'control: the second host name must reach the server')
        assert.equal(a.requests[0].headers.cookie, SECRET)
        assertNotReceived(a.requests[1], SECRET, 'other host name')
    })

    describe('sensitiveHeaders option', () => {
        it('strips caller-named headers case-insensitively', async () => {
            reset()
            await Request(`${a.url}${via(`${b.url}/final`)}`, {
                headers: { 'X-Tenant-Secret': SECRET, 'x-other-secret': SECRET, 'X-Keep': 'keep-me' },
                sensitiveHeaders: ['x-TENANT-secret', 'X-Other-Secret'],
                timeout: 5000,
            })
            assert.equal(a.requests[0].headers['x-tenant-secret'], SECRET)
            assertNotReceived(b.requests[0], SECRET, 'second origin')
            assert.equal(b.requests[0].headers['x-keep'], 'keep-me')
        })

        it('is additive: the built-in list still applies', async () => {
            reset()
            await Request(`${a.url}${via(`${b.url}/final`)}`, {
                headers: { Authorization: SECRET },
                sensitiveHeaders: ['X-Other'],
                timeout: 5000,
            })
            assertNotReceived(b.requests[0], SECRET, 'second origin')
        })

        it('keeps caller-named headers on a same-origin redirect', async () => {
            reset()
            await Request(`${a.url}${via('/final')}`, { headers: { 'X-Tenant-Secret': SECRET }, sensitiveHeaders: ['x-tenant-secret'], timeout: 5000 })
            assert.equal(a.requests[1].headers['x-tenant-secret'], SECRET)
        })

        it('rejects a value that is not an array of strings', async () => {
            const err = await rejection(Request(`${a.url}/x`, { sensitiveHeaders: 'x-secret' }))
            assert.match(err.message, /sensitiveHeaders must be an array of strings/)
            const err2 = await rejection(Request(`${a.url}/x`, { sensitiveHeaders: [1] }))
            assert.match(err2.message, /sensitiveHeaders must be an array of strings/)
        })
    })

    describe('array-form headers', () => {
        it('strips from a flat header array', async () => {
            reset()
            await Request(`${a.url}${via(`${b.url}/final`)}`, { headers: ['AUTHORIZATION', SECRET, 'Host', `127.0.0.1:${a.port}`, 'X-Keep', 'keep-me'], timeout: 5000 })
            assert.equal(a.requests[0].headers.authorization, SECRET)
            assertNotReceived(b.requests[0], SECRET, 'second origin')
            assert.equal(b.requests[0].headers['x-keep'], 'keep-me')
        })

        it('strips from a nested header array', async () => {
            reset()
            await Request(`${a.url}${via(`${b.url}/final`)}`, {
                headers: [
                    ['Cookie', SECRET],
                    ['Host', `127.0.0.1:${a.port}`],
                ],
                timeout: 5000,
            })
            assert.equal(a.requests[0].headers.cookie, SECRET)
            assertNotReceived(b.requests[0], SECRET, 'second origin')
        })
    })

    describe('options that override the URL', () => {
        it('compares origins against the host actually contacted, not the URL string', async () => {
            reset()
            // The URL names B, but `port` sends the request to A. A then redirects to the URL's own origin.
            const res = await Request(`${b.url}${via(`${b.url}/final`)}`, { port: a.port, headers: { Authorization: SECRET }, timeout: 5000 })
            assert.equal(res.buffer.toString(), 'B')
            assert.equal(a.requests[0].headers.authorization, SECRET)
            assertNotReceived(b.requests[0], SECRET, 'second origin')
        })

        it('follows a Location instead of re-requesting an overridden path', async () => {
            reset()
            const res = await Request(`${a.url}/ignored`, { path: via('/final'), headers: { Authorization: SECRET }, timeout: 5000 })
            assert.equal(res.statusCode, 200)
            assert.equal(a.requests[1].url, '/final')
            assert.equal(a.requests[1].headers.authorization, SECRET)
        })

        it('does not send a cross-origin hop to an overridden hostname', async () => {
            reset()
            const res = await Request(`http://placeholder.invalid${via(`${b.url}/final`)}`, { hostname: '127.0.0.1', port: a.port, auth: `u:${SECRET}`, timeout: 5000 })
            assert.equal(res.buffer.toString(), 'B')
            assert.equal(b.requests.length, 1)
            assert.equal(b.requests[0].headers.authorization, undefined)
        })
    })

    describe('non-http(s) redirect targets', () => {
        for (const target of ['file:///etc/passwd', 'ftp://127.0.0.1/secret', 'data:text/plain,hi', 'javascript:alert(1)', 'gopher://127.0.0.1/']) {
            it(`refuses ${target}`, async () => {
                reset()
                const err = await rejection(Request(`${a.url}${via(target)}`, { retry: 2, retryDelay: 1, headers: { Authorization: SECRET }, timeout: 5000 }))
                assert.match(err.message, /Refusing to follow redirect to unsupported protocol/)
                assert.equal(a.requests.length, 1, 'a refused redirect must not be retried')
            })
        }
    })

    describe('retries', () => {
        it('restores credentials only for the original origin on a fresh attempt', async () => {
            reset()
            const headers = { Authorization: SECRET }
            await Request(`${a.url}${via(`${b.url}/fail`)}`, { headers, retry: 1, retryDelay: 1, timeout: 5000 })
            assert.equal(a.requests.length, 2)
            assert.equal(b.requests.length, 2)
            for (const record of a.requests) assert.equal(record.headers.authorization, SECRET)
            for (const record of b.requests) assertNotReceived(record, SECRET, 'second origin')
        })
    })

    describe('caller inputs are not modified', () => {
        const cases = {
            'no redirect': (u) => [`${u.a}/final`, {}],
            'cross-origin redirect': (u) => [`${u.a}${via(`${u.b}/final`)}`, {}],
            'same-origin redirect': (u) => [`${u.a}${via('/final')}`, {}],
            '303 to GET with a body': (u) => [`${u.a}${via(`${u.b}/final`, 303)}`, { method: 'POST', body: 'payload' }],
            'multipart form': (u) => [`${u.a}/final`, { method: 'POST', formData: { field: 'value' } }],
            'retried failure': (u) => [`${u.a}/fail`, { retry: 1, retryDelay: 1 }],
        }

        for (const [name, build] of Object.entries(cases)) {
            it(`on ${name}`, async () => {
                reset()
                const [url, extra] = build({ a: a.url, b: b.url })
                const headers = {
                    Authorization: SECRET,
                    authorization: SECRET,
                    Cookie: SECRET,
                    'Content-Type': 'text/plain',
                    'content-length': extra.body ? String(extra.body.length) : undefined,
                }
                if (headers['content-length'] === undefined) delete headers['content-length']
                const options = { headers, auth: `u:${SECRET}`, timeout: 5000, sensitiveHeaders: ['X-Tenant'], ...extra }
                const headersBefore = structuredClone(headers)
                const optionsBefore = structuredClone(options)
                const keysBefore = Object.keys(options)

                await Request(url, options)

                assert.deepEqual(headers, headersBefore)
                assert.deepEqual(options, optionsBefore)
                assert.deepEqual(Object.keys(options), keysBefore)
                assert.equal(options.headers, headers, 'options.headers must still be the caller object')
            })
        }

        it('also accepts frozen options and headers', async () => {
            reset()
            const headers = Object.freeze({ Authorization: SECRET })
            await Request(`${a.url}${via(`${b.url}/final`, 303)}`, Object.freeze({ method: 'POST', body: 'payload', headers, timeout: 5000 }))
            assertNotReceived(b.requests[0], SECRET, 'second origin')
        })
    })

    it('removes content headers case-insensitively when a redirect drops the body', async () => {
        reset()
        await Request(`${a.url}${via(`${b.url}/final`, 303)}`, {
            method: 'POST',
            body: 'payload',
            headers: { 'CONTENT-TYPE': 'text/plain', 'CONTENT-LENGTH': '7' },
            timeout: 5000,
        })
        assert.equal(b.requests[0].method, 'GET')
        assert.equal(b.requests[0].headers['content-type'], undefined)
        assert.equal(b.requests[0].headers['content-length'], undefined)
        assert.equal(b.requests[0].body.length, 0)
    })
})

describe('redirect TLS credential handling', () => {
    let hasOpenssl = true
    let dir
    let cert
    let key
    let pfx
    const PASSPHRASE = 'synthetic-passphrase'

    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' })
    } catch {
        hasOpenssl = false
    }

    let peerA
    let peerB
    let tlsA
    let tlsB

    function makeTlsServer(peers, handler) {
        return startServer(handler, (listener) =>
            https.createServer({ cert, key, requestCert: true, rejectUnauthorized: false }, (req, res) => {
                peers.push(req.socket.getPeerCertificate()?.subject?.CN ?? null)
                listener(req, res)
            })
        )
    }

    before(async () => {
        if (!hasOpenssl) return
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagic-request-tls-'))
        const keyPath = path.join(dir, 'key.pem')
        const certPath = path.join(dir, 'cert.pem')
        const pfxPath = path.join(dir, 'client.p12')
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=synthetic-client'], { stdio: 'ignore' })
        execFileSync('openssl', ['pkcs12', '-export', '-inkey', keyPath, '-in', certPath, '-out', pfxPath, '-passout', `pass:${PASSPHRASE}`], { stdio: 'ignore' })
        cert = fs.readFileSync(certPath)
        key = fs.readFileSync(keyPath)
        pfx = fs.readFileSync(pfxPath)

        peerA = []
        peerB = []
        const handler = (req, res) => {
            const to = new URL(req.url, 'https://x').searchParams.get('to')
            if (to) respond(res, 302, { Location: to.replace('{b}', `https://127.0.0.1:${tlsB.port}`) }, '')
            else respond(res)
        }
        tlsA = await makeTlsServer(peerA, handler)
        tlsB = await makeTlsServer(peerB, handler)
    })

    after(async () => {
        if (!hasOpenssl) return
        await Promise.all([tlsA.close(), tlsB.close()])
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const optionSets = {
        'cert and key': () => ({ cert, key }),
        'pfx and passphrase': () => ({ pfx, passphrase: PASSPHRASE }),
        secureContext: () => ({ secureContext: tls.createSecureContext({ cert, key }) }),
        'a client-cert agent': () => ({ agent: new https.Agent({ cert, key, rejectUnauthorized: false }) }),
    }

    for (const [name, build] of Object.entries(optionSets)) {
        it(`does not present ${name} to a second origin`, { skip: !hasOpenssl && 'openssl is not available' }, async () => {
            peerA.length = 0
            peerB.length = 0
            const url = `https://127.0.0.1:${tlsA.port}/start?to=${encodeURIComponent('{b}/final')}`
            const res = await bounded(Request(url, { ...build(), rejectUnauthorized: false, timeout: 5000 }))
            assert.equal(res.statusCode, 200)
            assert.equal(peerA[0], 'synthetic-client', 'control: first origin must see the client certificate')
            assert.deepEqual(peerB, [null], 'second origin must not see a client certificate')
        })

        it(`keeps ${name} on a same-origin redirect`, { skip: !hasOpenssl && 'openssl is not available' }, async () => {
            peerA.length = 0
            const url = `https://127.0.0.1:${tlsA.port}/start?to=${encodeURIComponent('/final')}`
            const res = await bounded(Request(url, { ...build(), rejectUnauthorized: false, timeout: 5000 }))
            assert.equal(res.statusCode, 200)
            assert.deepEqual(peerA, ['synthetic-client', 'synthetic-client'])
        })
    }

    it('treats an https to http downgrade on the same host and port as cross-origin', { skip: !hasOpenssl && 'openssl is not available' }, async () => {
        // One port speaking both protocols, so the scheme is the only thing that differs.
        const received = []
        let port
        const app = (req, res) => {
            received.push({ encrypted: Boolean(req.socket.encrypted), headers: req.headers, url: req.url })
            if (req.socket.encrypted) respond(res, 302, { Location: `http://127.0.0.1:${port}/plain` }, '')
            else respond(res)
        }
        const plainServer = http.createServer(app)
        const secureServer = https.createServer({ cert, key }, app)
        const sockets = new Set()
        const mux = net.createServer((socket) => {
            sockets.add(socket)
            socket.once('readable', () => {
                const first = socket.read(1)
                if (first === null) return
                socket.unshift(first)
                ;(first[0] === 22 ? secureServer : plainServer).emit('connection', socket)
            })
        })
        await new Promise((resolve) => mux.listen(0, '127.0.0.1', resolve))
        port = mux.address().port
        try {
            const res = await bounded(
                Request(`https://127.0.0.1:${port}/secure`, {
                    rejectUnauthorized: false,
                    agent: false,
                    headers: { Authorization: SECRET, Cookie: SECRET },
                    auth: `u:${SECRET}`,
                    timeout: 5000,
                })
            )
            assert.equal(res.statusCode, 200)
            assert.deepEqual(
                received.map((r) => r.encrypted),
                [true, false]
            )
            assert.equal(received[0].headers.cookie, SECRET)
            assert.equal(received[1].headers.authorization, undefined)
            assert.equal(received[1].headers.cookie, undefined)
        } finally {
            for (const socket of sockets) socket.destroy()
            await new Promise((resolve) => mux.close(resolve))
        }
    })
})
