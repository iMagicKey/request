# imagic-request

> Minimal HTTP/HTTPS client with automatic decompression and multipart form support.

## Install

```bash
npm install imagic-request
```

## Quick Start

```js
import { Request } from 'imagic-request'

const res = await Request('https://api.example.com/data', {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
})

console.log(res.statusCode)
console.log(JSON.parse(res.buffer.toString()))
```

## API

### `Request(url, options?): Promise<IncomingMessage & { buffer: Buffer }>`

Makes an HTTP or HTTPS request. The protocol is determined from the URL scheme (`https:` uses `node:https`, everything else uses `node:http`).

```ts
Request(
    url: string,
    options?: {
        method?: string
        headers?: Record<string, string>
        body?: string | Buffer
        formData?: Record<string, string | number | boolean | bigint | Uint8Array | Readable | ReadableStream>
        timeout?: number
        deadline?: number
        sensitiveHeaders?: string[]
        // ...any other options accepted by node:http/https request()
    }
): Promise<IncomingMessage & { buffer: Buffer }>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `string` | Full URL including protocol. Required. |
| `options.method` | `string` | HTTP method (e.g. `'POST'`, `'GET'`). Defaults to Node.js default (`'GET'`). |
| `options.headers` | `object` | Request headers. When `formData` is set, `Content-Type: multipart/form-data; boundary=...` is added automatically. |
| `options.body` | `string \| Buffer` | Raw request body. Mutually exclusive with `formData`. |
| `options.formData` | `object` | Fields for a `multipart/form-data` request, as a plain object. String and Buffer values become plain fields (Buffers are sent as raw bytes); Node and web stream values become file uploads. See the field table below. |
| `options.timeout` | `number` | Socket idle timeout in milliseconds, per request hop (default: `30000`). The request is destroyed and an error is thrown when no data moves for this long; a slow but steady response never trips it. |
| `options.deadline` | `number` | Total time limit in milliseconds across connecting, redirects, retries, backoff and the body (default: none). |
| `options.sensitiveHeaders` | `string[]` | Extra header names to remove when a redirect changes origin. |

Any additional properties in `options` are forwarded directly to `node:http/https`'s `request()` (e.g. `agent`, `hostname`, `auth`).

**Redirects:** a redirect that changes scheme, host or port removes `Authorization`, `Cookie`, `Proxy-Authorization`, `Host`, `X-Api-Key` and `X-Auth-Token` (case-insensitive), plus anything named in `options.sensitiveHeaders`, and drops `auth`, client certificate options and any custom `agent`. They stay removed if the chain later returns to the original origin. Redirects to anything other than `http:` or `https:` are refused with an error.

**Return value:**

Resolves with Node.js `IncomingMessage` extended with one additional property:

| Property | Type | Description |
|----------|------|-------------|
| `buffer` | `Buffer` | Full response body, automatically decompressed |
| `statusCode` | `number` | HTTP status code (from `IncomingMessage`) |
| `headers` | `object` | Response headers (from `IncomingMessage`) |

**Automatic decompression:**

The response body is transparently decompressed based on the `Content-Encoding` header:

| Encoding | Decompressor |
|----------|-------------|
| `br` | `zlib.createBrotliDecompress()` |
| `gzip` | `zlib.createGunzip()` |
| `deflate` | `zlib.createInflate()` |
| _(anything else)_ | No decompression |

---

### `formData` — multipart file uploads

When `options.formData` is set, `Request` builds a `multipart/form-data` body automatically.

```js
import fs from 'node:fs'

const res = await Request('https://upload.example.com/files', {
    method: 'POST',
    formData: {
        description: 'my file',          // plain text field
        file: fs.createReadStream('/path/to/file.pdf'),  // file upload
    },
})
```

**Field behavior:**

| Field value type | Behavior |
|-----------------|----------|
| `string` | Sent as a plain `form-data` field, UTF-8 encoded |
| `number`, `boolean` or `bigint` | Sent as a plain `form-data` field, as text |
| `Buffer` or `Uint8Array` | Sent as a plain `form-data` field with the exact bytes (no `filename` or `Content-Type`). Use a stream if the receiver expects a file part |
| Node `Readable` with `.path` property | Sent as a file; MIME type and filename derived from `stream.path` |
| Node `Readable` without `.path`, or web `ReadableStream` | Sent as a file with MIME `application/octet-stream` and filename `filename` |
| Anything else: `Blob`, `File`, `ArrayBuffer`, other typed arrays, objects, arrays, `null`, or a stream already consumed or destroyed | Throws a `TypeError`; nothing is sent |

**MIME type detection** is based on file extension. Supported extensions include common image, video, audio, document, archive, and code formats. Unknown extensions fall back to `application/octet-stream`.

`formData` itself must be a plain object: a `FormData` or `Map` throws a `TypeError`. Fields are written in the order they appear in the `formData` object. The boundary string is generated randomly per request. In field names and filenames, `"`, CR and LF are escaped as `%22`, `%0D` and `%0A`, as in the WHATWG form encoding.

### `stream(url, options?): Promise<{ statusCode, headers, stream }>`

Sends the request like `Request`, including `body` and `formData`, and returns the decompressed response body as a readable stream without buffering it.

`stream()` makes a single request. It does not follow redirects (a 3xx response is returned as it is), retry or limit the body, so `followRedirects`, `maxRedirects`, `retry`, `retryDelay`, `retryStatusCodes` and `maxBodySize` have no effect. `deadline` also covers reading the body: the returned stream errors if it has not finished in time.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `url` is not a string | Throws `Error: URL must be a string` |
| `options` is not an object | Throws `Error: Options must be an object` |
| `options.timeout` exceeded | Request destroyed; rejects with `Error: Request timed out` |
| `options.deadline` exceeded | Request destroyed; rejects with an error with `name: 'TimeoutError'` and `code: 'ETIMEDOUT'`; partial data attached as `err.buffer` when the body had started |
| 101 protocol switch or any reply to `CONNECT` | Socket destroyed; rejects with `Error: Unexpected <status> response`. Upgrades and tunnels are not supported |
| Network error | Rejects with the underlying Node.js `Error`; partially received data is attached as `err.buffer` |
| Stream read error on response | Rejects with the underlying error; partial data attached as `err.buffer` |

Status codes in the 4xx–5xx range do **not** cause rejection — they are returned normally via `res.statusCode`.

## Examples

See [`examples/`](examples/) for runnable scripts.

**GET request:**

```js
import { Request } from '../src/index.js'

const res = await Request('https://httpbin.org/get')
console.log(res.statusCode)
console.log(res.buffer.toString())
```

**POST with JSON body:**

```js
const res = await Request('https://httpbin.org/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'value' }),
    timeout: 5000,
})

const data = JSON.parse(res.buffer.toString())
console.log(data)
```

**File upload:**

```js
import fs from 'node:fs'

const res = await Request('https://httpbin.org/post', {
    method: 'POST',
    formData: {
        name: 'example',
        attachment: fs.createReadStream('./report.pdf'),
    },
})
console.log(res.statusCode)
```

## License

MIT
