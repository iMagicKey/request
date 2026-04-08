import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import createMultipartForm from './modules/multipartform.js'

const DEFAULT_TIMEOUT = 30000
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization']
const DEFAULT_RETRY_STATUS_CODES = [500, 502, 503, 504, 408]
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'])

function doRequest(url, requestOptions, body, timeout, maxBodySize) {
    const requester = url.startsWith('https:') ? https : http

    return new Promise((resolve, reject) => {
        const buffers = []
        let receivedLength = 0

        const request = requester.request(url, requestOptions, (res) => {
            let output
            switch (res.headers['content-encoding']) {
                case 'br':
                    output = res.pipe(zlib.createBrotliDecompress())
                    break
                case 'gzip':
                    output = res.pipe(zlib.createGunzip())
                    break
                case 'deflate':
                    output = res.pipe(zlib.createInflate())
                    break
                default:
                    output = res
                    break
            }

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

        if (body) {
            if (body.readable) {
                body.on('error', (err) => {
                    request.destroy()
                    reject(err)
                })
                body.pipe(request)
                body.on('finish', () => {
                    request.end()
                })
            } else {
                request.end(body)
            }
        } else {
            request.end()
        }
    })
}

async function Request(url = '', options = {}) {
    if (typeof url !== 'string') throw new Error('URL must be a string')
    if (typeof options !== 'object' || options === null) throw new Error('Options must be an object')

    const requestOptions = {
        headers: {},
        ...options,
    }

    if (requestOptions.body !== undefined && typeof requestOptions.body !== 'string' && !Buffer.isBuffer(requestOptions.body)) {
        throw new Error('body must be a string or Buffer')
    }

    if (requestOptions.dns !== undefined) {
        if (typeof requestOptions.dns !== 'string') {
            throw new Error('dns must be a string (IP address of DNS server)')
        }
        const resolver = new dns.Resolver()
        resolver.setServers([requestOptions.dns])
        requestOptions.lookup = (hostname, _opts, callback) => {
            resolver.resolve4(hostname, (err, addresses) => {
                if (err) return callback(err)
                callback(null, addresses[0], 4)
            })
        }
        delete requestOptions.dns
    }

    if (requestOptions.formData) {
        const formData = createMultipartForm(requestOptions.formData)
        requestOptions.formData = formData.dataStream
        requestOptions.headers = requestOptions.headers || {}
        requestOptions.headers['Content-Type'] = `multipart/form-data; boundary=${formData.boundary}`
    }

    const followRedirects = requestOptions.followRedirects !== false
    const maxRedirects = requestOptions.maxRedirects || 10
    delete requestOptions.followRedirects
    delete requestOptions.maxRedirects

    const maxBodySize = requestOptions.maxBodySize || 0
    delete requestOptions.maxBodySize

    const retryLimit = requestOptions.retry || 0
    const retryDelay = requestOptions.retryDelay || 1000
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
                networkError = err
                break
            }

            if (!followRedirects || !REDIRECT_CODES.has(res.statusCode) || !res.headers.location) {
                break
            }

            if (redirectCount >= maxRedirects) {
                throw new Error(`Maximum number of redirects exceeded (${maxRedirects})`)
            }

            const newUrl = new URL(res.headers.location, currentUrl).href

            // RFC 7231: 303 → always GET; 301/302 + POST → GET (de facto standard)
            const currentMethod = (opts.method || 'GET').toUpperCase()
            if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && currentMethod === 'POST')) {
                opts.method = 'GET'
                currentBody = undefined
                delete opts.headers['content-type']
                delete opts.headers['Content-Type']
                delete opts.headers['content-length']
                delete opts.headers['Content-Length']
            }

            // Strip sensitive headers on cross-origin redirect
            const oldOrigin = new URL(currentUrl).origin
            const newOrigin = new URL(newUrl).origin
            if (oldOrigin !== newOrigin) {
                for (const header of SENSITIVE_HEADERS) {
                    delete opts.headers[header]
                }
            }

            currentUrl = newUrl
        }

        // Retry decision
        if (attempt < retryLimit && retryLimit > 0 && isIdempotent) {
            const shouldRetry = networkError || (res && retryStatusCodes.has(res.statusCode))
            if (shouldRetry) {
                const baseDelay = retryDelay * (2 ** attempt)
                const jitter = Math.floor(Math.random() * baseDelay * 0.2)
                const delay = baseDelay + jitter
                await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)))
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
        headers: {},
        ...options,
    }

    if (requestOptions.dns !== undefined) {
        if (typeof requestOptions.dns !== 'string') {
            throw new Error('dns must be a string (IP address of DNS server)')
        }
        const resolver = new dns.Resolver()
        resolver.setServers([requestOptions.dns])
        requestOptions.lookup = (hostname, _opts, callback) => {
            resolver.resolve4(hostname, (err, addresses) => {
                if (err) return callback(err)
                callback(null, addresses[0], 4)
            })
        }
        delete requestOptions.dns
    }

    const timeout = requestOptions.timeout === undefined ? DEFAULT_TIMEOUT : requestOptions.timeout
    const requester = url.startsWith('https:') ? https : http

    return new Promise((resolve, reject) => {
        const request = requester.request(url, requestOptions, (res) => {
            let output
            switch (res.headers['content-encoding']) {
                case 'br':
                    output = res.pipe(zlib.createBrotliDecompress())
                    break
                case 'gzip':
                    output = res.pipe(zlib.createGunzip())
                    break
                case 'deflate':
                    output = res.pipe(zlib.createInflate())
                    break
                default:
                    output = res
                    break
            }

            resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                stream: output,
            })
        })

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

        request.end()
    })
}

export { Request, stream }
export default Request
