import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import zlib from 'node:zlib'
import createMultipartForm from './modules/multipartform.js'

const DEFAULT_TIMEOUT = 30000
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
// Removed when a redirect changes origin. Names are compared lowercase.
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'host', 'x-api-key', 'x-auth-token']
const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding'])
// Options that authenticate the caller or tie the connection to the origin they were given for.
// `agent`, `secureContext` and `createConnection` are included because they can hold client certificates or a fixed target.
const ORIGIN_BOUND_OPTIONS = [
    'auth',
    'cert',
    'key',
    'pfx',
    'passphrase',
    'secureContext',
    'session',
    'servername',
    'pskCallback',
    'clientCertEngine',
    'privateKeyEngine',
    'privateKeyIdentifier',
    'agent',
    'createConnection',
    'socketPath',
]
// Options that override parts of the URL. Once a redirect is followed, the Location is authoritative.
const URL_OVERRIDE_OPTIONS = ['protocol', 'hostname', 'host', 'port', 'path', 'defaultPort']
const DEFAULT_RETRY_STATUS_CODES = [500, 502, 503, 504, 408]
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'])

// The largest delay a Node.js timer can hold. Anything beyond it would fire almost immediately.
const MAX_DEADLINE = 2 ** 31 - 1

function readDeadline(value = 0) {
    if (typeof value !== 'number' || !(value >= 0) || value > MAX_DEADLINE) {
        throw new Error(`deadline must be a number of milliseconds between 0 and ${MAX_DEADLINE}`)
    }
    return value
}

function deadlineError(deadline) {
    const err = new Error(`Request deadline of ${deadline} ms exceeded`)
    err.name = 'TimeoutError'
    err.code = 'ETIMEDOUT'
    return err
}

const isStream = (body) => typeof body?.pipe === 'function'

/** The same error node:http raises for an aborted signal. */
function abortError(signal) {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    err.code = 'ABORT_ERR'
    err.cause = signal.reason
    return err
}

/**
 * The response body as a readable stream, decompressed according to Content-Encoding.
 * The pipeline destroys the decompressor if the response errors or closes early,
 * so a truncated body fails the reader instead of leaving it waiting forever.
 */
function decodedBody(res, method) {
    // These have no body even when they carry a Content-Encoding header, and zlib rejects empty input.
    const hasBody = method !== 'HEAD' && res.statusCode >= 200 && res.statusCode !== 204 && res.statusCode !== 304 && res.headers['content-length'] !== '0'
    const encoding = hasBody ? res.headers['content-encoding'] : undefined

    let decompressor
    if (encoding === 'br') decompressor = zlib.createBrotliDecompress()
    else if (encoding === 'gzip') decompressor = zlib.createGunzip()
    else if (encoding === 'deflate') decompressor = zlib.createInflate()
    else return res

    // Errors reach the reader through the decompressor's own 'error' event.
    pipeline(res, decompressor, () => {})
    return decompressor
}

/**
 * Reject a request that ends without a usable HTTP response. A 101, or any reply to CONNECT, only
 * raises 'upgrade' or 'connect', and the request then closes with no response and no error.
 */
function rejectWithoutResponse(request, reject) {
    let responded = false
    request.once('response', () => {
        responded = true
    })
    const onSwitch = (res, socket) => {
        socket.destroy()
        reject(new Error(`Unexpected ${res.statusCode} response: protocol upgrades and CONNECT tunnels are not supported`))
    }
    request.on('upgrade', onSwitch)
    request.on('connect', onSwitch)
    request.once('close', () => {
        if (!responded) reject(new Error('Request closed before a response was received'))
    })
}

function sendBody(request, body, reject) {
    if (isStream(body)) {
        body.on('error', (err) => {
            request.destroy()
            reject(err)
        })
        body.pipe(request)
    } else if (body) {
        request.end(body)
    } else {
        request.end()
    }
}

function doRequest(url, requestOptions, body, timeout, maxBodySize) {
    const requester = url.startsWith('https:') ? https : http

    return new Promise((resolve, reject) => {
        const buffers = []
        let receivedLength = 0

        const request = requester.request(url, requestOptions, (res) => {
            const output = decodedBody(res, request.method)

            output.on('data', (data) => {
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
                receivedLength += chunk.length
                if (maxBodySize && receivedLength > maxBodySize) {
                    request.destroy()
                    return reject(new Error(`Response body exceeded maxBodySize of ${maxBodySize} bytes`))
                }
                buffers.push(chunk)
            })

            output.on('end', () => {
                res.buffer = Buffer.concat(buffers)
                return resolve(res)
            })

            output.on('error', (err) => {
                err.buffer = Buffer.concat(buffers)
                return reject(err)
            })
        })

        rejectWithoutResponse(request, reject)

        request.on('timeout', () => {
            request.destroy()
            return reject(new Error('Request timed out'))
        })

        request.on('error', (err) => {
            err.buffer = Buffer.concat(buffers)
            return reject(err)
        })

        if (timeout) {
            request.setTimeout(timeout)
        }

        sendBody(request, body, reject)
    })
}

/** A `lookup` for node:net that asks one DNS server. Node requests every address (`all: true`) by default. */
function createLookup(server) {
    const resolver = new dns.Resolver()
    resolver.setServers([server])
    return (hostname, options, callback) => {
        resolver.resolve4(hostname, (err, addresses) => {
            if (err) return callback(err)
            if (options.all) return callback(null, addresses.map((address) => ({ address, family: 4 })))
            callback(null, addresses[0], 4)
        })
    }
}

/** Return a copy of `headers` (object, flat array or nested array) without the given lowercase names. */
function withoutHeaders(headers, names) {
    const drop = (name) => names.has(String(name).toLowerCase())
    if (!Array.isArray(headers)) return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !drop(name)))
    if (Array.isArray(headers[0])) return headers.filter(([name]) => !drop(name))
    const kept = []
    for (let i = 0; i < headers.length; i += 2) {
        if (!drop(headers[i])) kept.push(headers[i], headers[i + 1])
    }
    return kept
}

/** The URL a request is actually sent to: node:http lets these options override the URL. */
function resolveTarget(url, options) {
    const target = new URL(url)
    if (options.protocol) target.protocol = options.protocol
    if (options.hostname) target.hostname = options.hostname
    if (options.port) target.port = options.port
    if (options.path) {
        const query = options.path.indexOf('?')
        target.pathname = query === -1 ? options.path : options.path.slice(0, query)
        target.search = query === -1 ? '' : options.path.slice(query)
    }
    return target
}

async function Request(url = '', options = {}) {
    if (typeof url !== 'string') throw new Error('URL must be a string')
    if (typeof options !== 'object' || options === null) throw new Error('Options must be an object')

    const requestOptions = {
        ...options,
        headers: withoutHeaders(options.headers, new Set()),
    }

    if (requestOptions.body !== undefined && typeof requestOptions.body !== 'string' && !Buffer.isBuffer(requestOptions.body)) {
        throw new Error('body must be a string or Buffer')
    }

    if (requestOptions.dns !== undefined) {
        if (typeof requestOptions.dns !== 'string') {
            throw new Error('dns must be a string (IP address of DNS server)')
        }
        requestOptions.lookup = createLookup(requestOptions.dns)
        delete requestOptions.dns
    }

    if (requestOptions.formData) {
        const formData = createMultipartForm(requestOptions.formData)
        requestOptions.formData = formData.dataStream
        requestOptions.headers['Content-Type'] = `multipart/form-data; boundary=${formData.boundary}`
    }

    const customSensitiveHeaders = requestOptions.sensitiveHeaders ?? []
    if (!Array.isArray(customSensitiveHeaders) || customSensitiveHeaders.some((name) => typeof name !== 'string')) {
        throw new Error('sensitiveHeaders must be an array of strings')
    }
    const sensitiveHeaders = new Set([...SENSITIVE_HEADERS, ...customSensitiveHeaders.map((name) => name.toLowerCase())])
    delete requestOptions.sensitiveHeaders

    const followRedirects = requestOptions.followRedirects !== false
    const maxRedirects = requestOptions.maxRedirects ?? 10
    delete requestOptions.followRedirects
    delete requestOptions.maxRedirects

    const maxBodySize = requestOptions.maxBodySize || 0
    delete requestOptions.maxBodySize

    const retryLimit = requestOptions.retry || 0
    const retryDelay = requestOptions.retryDelay ?? 1000
    const retryStatusCodes = new Set(requestOptions.retryStatusCodes || DEFAULT_RETRY_STATUS_CODES)
    delete requestOptions.retry
    delete requestOptions.retryDelay
    delete requestOptions.retryStatusCodes

    const timeout = requestOptions.timeout === undefined ? DEFAULT_TIMEOUT : requestOptions.timeout

    const body = requestOptions.formData || requestOptions.body
    delete requestOptions.body
    delete requestOptions.formData

    const method = (requestOptions.method || 'GET').toUpperCase()
    const isIdempotent = IDEMPOTENT_METHODS.has(method)

    // One signal covers every hop, attempt and backoff, so the deadline spans the whole operation.
    const deadline = readDeadline(requestOptions.deadline)
    delete requestOptions.deadline
    const callerSignal = requestOptions.signal
    const deadlineSignal = deadline > 0 ? AbortSignal.timeout(deadline) : undefined
    if (deadlineSignal) requestOptions.signal = callerSignal ? AbortSignal.any([callerSignal, deadlineSignal]) : deadlineSignal
    const { signal } = requestOptions
    const cancellation = () => (deadlineSignal && signal.reason === deadlineSignal.reason ? deadlineError(deadline) : abortError(signal))

    if (signal?.aborted) throw cancellation()

    for (let attempt = 0; ; attempt++) {
        let res
        let networkError

        // Redirect-aware single attempt
        let currentUrl = url
        let currentBody = body
        const opts = { ...requestOptions }

        for (let redirectCount = 0; ; redirectCount++) {
            try {
                res = await doRequest(currentUrl, opts, currentBody, timeout, maxBodySize)
            } catch (err) {
                // A cancelled request is never retried. Depending on timing, the abort can
                // surface as a reset of the response, so report the actual cause.
                if (signal?.aborted) throw Object.assign(cancellation(), { buffer: err.buffer })
                networkError = err
                break
            }

            if (!followRedirects || !REDIRECT_CODES.has(res.statusCode) || !res.headers.location) {
                break
            }

            if (redirectCount >= maxRedirects) {
                throw new Error(`Maximum number of redirects exceeded (${maxRedirects})`)
            }

            const from = resolveTarget(currentUrl, opts)
            const to = new URL(res.headers.location, from)
            if (to.protocol !== 'http:' && to.protocol !== 'https:') {
                throw new Error(`Refusing to follow redirect to unsupported protocol "${to.protocol}"`)
            }

            // RFC 7231: 303 → always GET; 301/302 + POST → GET (de facto standard)
            const currentMethod = (opts.method || 'GET').toUpperCase()
            if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && currentMethod === 'POST')) {
                opts.method = 'GET'
                currentBody = undefined
                opts.headers = withoutHeaders(opts.headers, BODY_HEADERS)
            }

            // `opts` lives for the whole chain, so anything removed here stays removed
            // if a later redirect returns to the original origin.
            if (from.origin !== to.origin) {
                opts.headers = withoutHeaders(opts.headers, sensitiveHeaders)
                for (const name of ORIGIN_BOUND_OPTIONS) delete opts[name]
                // node:http adds no Host header of its own for array-form headers.
                if (Array.isArray(opts.headers)) {
                    opts.headers = Array.isArray(opts.headers[0]) ? [...opts.headers, ['Host', to.host]] : [...opts.headers, 'Host', to.host]
                }
            }
            for (const name of URL_OVERRIDE_OPTIONS) delete opts[name]

            if (isStream(currentBody)) {
                throw new Error(`Cannot follow ${res.statusCode} redirect: a multipart or stream request body cannot be replayed`)
            }

            currentUrl = to.href
        }

        // Retry decision
        if (attempt < retryLimit && retryLimit > 0 && isIdempotent && !isStream(body)) {
            const shouldRetry = networkError || (res && retryStatusCodes.has(res.statusCode))
            if (shouldRetry) {
                const baseDelay = retryDelay * (2 ** attempt)
                const jitter = Math.floor(Math.random() * baseDelay * 0.2)
                const delay = baseDelay + jitter
                try {
                    await sleep(Math.max(0, delay), undefined, { signal })
                } catch {
                    throw cancellation()
                }
                continue
            }
        }

        if (networkError) throw networkError
        return res
    }
}

function stream(url = '', options = {}) {
    if (typeof url !== 'string') throw new Error('URL must be a string')
    if (typeof options !== 'object' || options === null) throw new Error('Options must be an object')

    const requestOptions = {
        ...options,
        headers: withoutHeaders(options.headers, new Set()),
    }

    if (requestOptions.body !== undefined && typeof requestOptions.body !== 'string' && !Buffer.isBuffer(requestOptions.body)) {
        throw new Error('body must be a string or Buffer')
    }

    if (requestOptions.dns !== undefined) {
        if (typeof requestOptions.dns !== 'string') {
            throw new Error('dns must be a string (IP address of DNS server)')
        }
        requestOptions.lookup = createLookup(requestOptions.dns)
        delete requestOptions.dns
    }

    if (requestOptions.formData) {
        const formData = createMultipartForm(requestOptions.formData)
        requestOptions.formData = formData.dataStream
        requestOptions.headers['Content-Type'] = `multipart/form-data; boundary=${formData.boundary}`
    }

    const body = requestOptions.formData || requestOptions.body
    delete requestOptions.body
    delete requestOptions.formData

    const deadline = readDeadline(requestOptions.deadline)
    delete requestOptions.deadline

    const timeout = requestOptions.timeout === undefined ? DEFAULT_TIMEOUT : requestOptions.timeout
    const requester = url.startsWith('https:') ? https : http

    return new Promise((resolve, reject) => {
        let output

        const request = requester.request(url, requestOptions, (res) => {
            output = decodedBody(res, request.method)
            // A decompression error is delivered to whoever reads the stream. Like a plain response,
            // it must not take the process down if the caller attached no 'error' listener.
            if (output !== res) output.on('error', () => {})

            resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                stream: output,
            })
        })

        rejectWithoutResponse(request, reject)

        request.on('timeout', () => {
            request.destroy()
            return reject(new Error('Request timed out'))
        })

        request.on('error', (err) => {
            return reject(err)
        })

        if (timeout) {
            request.setTimeout(timeout)
        }

        if (deadline > 0) {
            const timer = setTimeout(() => {
                const err = deadlineError(deadline)
                output?.destroy(err)
                request.destroy(err)
            }, deadline)
            timer.unref()
            request.once('close', () => clearTimeout(timer))
        }

        sendBody(request, body, reject)
    })
}

export { Request, stream }
export default Request
