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
        formData?: Record<string, string | Buffer | ReadableStream>
        timeout?: number
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
| `options.formData` | `object` | Fields for a `multipart/form-data` request. String and Buffer values become plain text fields; `ReadableStream` values become file uploads. |
| `options.timeout` | `number` | Request timeout in milliseconds. The request is destroyed and an error is thrown on expiry. |

Any additional properties in `options` are forwarded directly to `node:http/https`'s `request()` (e.g. `agent`, `hostname`, `auth`).

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
| `string` or `Buffer` | Sent as a plain `form-data` text field |
| `ReadableStream` with `.path` property | Sent as a file; MIME type and filename derived from `stream.path` |
| `ReadableStream` without `.path` | Sent as a file with MIME `application/octet-stream` and filename `filename` |

**MIME type detection** is based on file extension. Supported extensions include common image, video, audio, document, archive, and code formats. Unknown extensions fall back to `application/octet-stream`.

Fields are written in the order they appear in the `formData` object. The boundary string is generated randomly per request.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `url` is not a string | Throws `Error: URL must be a string` |
| `options` is not an object | Throws `Error: Options must be an object` |
| `options.timeout` exceeded | Request destroyed; rejects with `Error: Request timed out` |
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
