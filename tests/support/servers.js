import http from 'node:http'
import assert from 'node:assert/strict'

/**
 * Start a real loopback HTTP server that records every request it receives.
 * `handler(req, res, record)` is called after the request body has been read.
 */
export async function startServer(handler, createServer = http.createServer) {
    const requests = []
    const server = createServer((req, res) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('error', () => {})
        req.on('end', () => {
            const record = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                body: Buffer.concat(chunks),
            }
            requests.push(record)
            handler(req, res, record)
        })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    return {
        server,
        port,
        requests,
        url: `http://127.0.0.1:${port}`,
        close() {
            server.closeAllConnections?.()
            return new Promise((resolve) => server.close(resolve))
        },
    }
}

export function respond(res, status = 200, headers = {}, body = 'ok') {
    res.writeHead(status, headers)
    res.end(body)
}

/** Fail, rather than stall, if `promise` has not settled within `ms`. */
export async function bounded(promise, ms = 5000) {
    let timer
    const limit = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)
    })
    try {
        return await Promise.race([promise, limit])
    } finally {
        clearTimeout(timer)
    }
}

/** Assert that `promise` rejects (never hangs) and return the rejection reason. */
export async function rejection(promise, ms = 5000) {
    const outcome = await bounded(
        promise.then(
            () => ({ settled: 'resolved' }),
            (err) => ({ settled: 'rejected', err })
        ),
        ms
    )
    assert.equal(outcome.settled, 'rejected', 'expected the promise to reject')
    return outcome.err
}

/** Assert that a synthetic secret appears nowhere in what a server received. */
export function assertNotReceived(record, secret, label = 'request') {
    const seen = [record.url, JSON.stringify(record.rawHeaders), record.body.toString('latin1')].join('\n').toLowerCase()
    assert.equal(seen.includes(secret.toLowerCase()), false, `${label} must not contain ${secret}: ${seen}`)
}
