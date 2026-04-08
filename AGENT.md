# AGENT — imagic-request

## Purpose

Make HTTP/HTTPS requests with automatic decompression (br/gzip/deflate) and built-in multipart/form-data support; returns the full response body as a `Buffer`.

## Package

- npm: `imagic-request`
- import (local): `import { Request } from '../src/index.js'`
- import (installed): `import { Request } from 'imagic-request'`
- zero runtime deps (uses `node:http`, `node:https`, `node:zlib`, `node:stream`, `node:path`)

## Exports

### `Request` (named export + default export)

```js
import { Request } from 'imagic-request'
// or
import Request from 'imagic-request'
```

---

## `Request(url, options?): Promise<IncomingMessage & { buffer: Buffer }>`

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `url` | `string` | yes | — | Full URL with protocol; `https:` uses `node:https`, everything else uses `node:http` |
| `options` | `object` | no | `{}` | See below |
| `options.method` | `string` | no | Node.js default (`'GET'`) | HTTP method |
| `options.headers` | `object` | no | `{}` | Request headers; `Content-Type` for multipart is auto-set when `formData` is present |
| `options.body` | `string \| Buffer` | no | — | Raw body; mutually exclusive with `formData` |
| `options.formData` | `Record<string, string \| Buffer \| ReadableStream>` | no | — | Multipart fields; see below |
| `options.timeout` | `number` | no | — | Ms before request is destroyed; rejects with `Error: Request timed out` |
| _...rest_ | any | no | — | Forwarded verbatim to `node:http/https`'s `request()` |

**Returns:** `IncomingMessage` extended with `buffer: Buffer` (full decompressed body).

- `res.statusCode` — HTTP status code
- `res.headers` — response headers
- `res.buffer` — full body as `Buffer`

**Auto-decompression** based on `Content-Encoding` response header:
- `br` → `zlib.createBrotliDecompress()`
- `gzip` → `zlib.createGunzip()`
- `deflate` → `zlib.createInflate()`
- anything else → raw passthrough

---

## formData behavior

When `options.formData` is set:
- `Content-Type: multipart/form-data; boundary=...` is automatically added to headers
- `options.body` is ignored if `formData` is present (formData takes precedence in the send logic)
- String or Buffer values → plain `form-data` text fields
- `ReadableStream` with `.path` property → file field; MIME and filename derived from `stream.path`
- `ReadableStream` without `.path` → file field; MIME `application/octet-stream`, filename `filename`
- Fields are written in object key order

---

## Usage Patterns

### Simple GET

```js
const res = await Request('https://api.example.com/items')
const data = JSON.parse(res.buffer.toString('utf8'))
```

### POST with JSON

```js
const res = await Request('https://api.example.com/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test' }),
    timeout: 10000,
})
```

### Multipart file upload

```js
import fs from 'node:fs'

const res = await Request('https://api.example.com/upload', {
    method: 'POST',
    formData: {
        title: 'My Report',
        file: fs.createReadStream('/tmp/report.pdf'),
    },
})
```

### Check status without throwing

```js
const res = await Request('https://api.example.com/resource')
if (res.statusCode === 404) {
    // handle not found — does NOT throw
}
```

---

## Constraints / Gotchas

- `url` must be a `string`; passing a non-string throws synchronously before the request is made
- `options` must be an object; passing `null` throws synchronously
- HTTP 4xx/5xx responses do **not** reject the promise; check `res.statusCode` manually
- On network error, the error object has a `.buffer` property containing any bytes received before the failure
- On timeout, the request is destroyed and the promise rejects with `Error: Request timed out`; there is no partial buffer attached
- Compression detection is purely header-based (`Content-Encoding`); no content sniffing
- `formData` streams are piped lazily via `Duplex._read`; all fields are processed sequentially in key order
- The boundary string in `formData` is randomly generated each call; there is no way to override it
- When both `body` and `formData` are provided, `formData` wins (the pipe branch executes because `requestData.readable` is truthy)
- There is no redirect following — responses with 3xx status codes are returned as-is
- No retry logic built in

---

## Knowledge Base

**KB tags for this library:** `imagic-request, api`

Before COMPLEX tasks — invoke `knowledge-reader` with tags above + task-specific tags.
After completing a task — if a reusable pattern, error, or decision emerged, invoke `knowledge-writer` with `source: imagic-request`.

See `CLAUDE.md` §Knowledge Base Protocol for the full workflow.
