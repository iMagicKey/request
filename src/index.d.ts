import { IncomingMessage, IncomingHttpHeaders } from 'node:http'
import { Readable } from 'node:stream'

export interface RequestOptions {
    /** HTTP method (default: 'GET') */
    method?: string
    /** Request headers */
    headers?: Record<string, string>
    /** Request body — string or Buffer only. Plain objects throw an error. */
    body?: string | Buffer
    /** Multipart form-data fields. Takes precedence over `body`. */
    formData?: Record<string, string | Buffer | Readable>
    /** Timeout in milliseconds (default: 30000). Set to 0 to disable. */
    timeout?: number
    /** Custom DNS server IP address for hostname resolution */
    dns?: string
    /** Maximum response body size in bytes. 0 = unlimited (default). */
    maxBodySize?: number
    /** Follow HTTP redirects (default: true) */
    followRedirects?: boolean
    /** Maximum number of redirects to follow (default: 10). Exceeding it rejects; with 0, any redirect response rejects. Use `followRedirects: false` to receive the 3xx response instead. */
    maxRedirects?: number
    /**
     * Extra header names (case-insensitive) to remove when a redirect changes origin, in addition to
     * Authorization, Cookie, Proxy-Authorization, Host, X-Api-Key and X-Auth-Token.
     */
    sensitiveHeaders?: string[]
    /** Number of retries on network errors or retryable status codes (default: 0) */
    retry?: number
    /** Base delay between retries in ms, doubled each attempt (default: 1000). 0 retries with no delay. */
    retryDelay?: number
    /** HTTP status codes to retry on (default: [500, 502, 503, 504, 408]) */
    retryStatusCodes?: number[]
    /** AbortSignal for request cancellation. An aborted request rejects promptly and is never retried. */
    signal?: AbortSignal
    /** Any additional options forwarded to node:http/https request() */
    [key: string]: unknown
}

export interface RequestResponse extends IncomingMessage {
    /** Full response body as a Buffer (decompressed) */
    buffer: Buffer
}

export interface StreamResponse {
    /** HTTP status code */
    statusCode: number
    /** Response headers */
    headers: IncomingHttpHeaders
    /** Readable stream of the response body (decompressed) */
    stream: Readable
}

/**
 * Make an HTTP/HTTPS request and buffer the entire response.
 *
 * Automatically decompresses br/gzip/deflate responses.
 * HTTP 4xx/5xx responses do NOT reject — check `res.statusCode`.
 */
export function Request(url: string, options?: RequestOptions): Promise<RequestResponse>

/**
 * Make an HTTP/HTTPS request and return a readable stream.
 *
 * Does not buffer the response in memory — use for large downloads or piping.
 * Automatically decompresses br/gzip/deflate responses.
 */
export function stream(url: string, options?: RequestOptions): Promise<StreamResponse>

export default Request
