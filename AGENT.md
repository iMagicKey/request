# AGENT — imagic-request

## Purpose

Make HTTP/HTTPS requests with automatic decompression (br/gzip/deflate), multipart/form-data, redirect following, retry, and streaming support. Zero runtime dependencies.

## Package

- npm: `imagic-request`
- import (local): `import { Request, stream } from '../src/index.js'`
- import (installed): `import { Request, stream } from 'imagic-request'`
- zero runtime deps (uses `node:dns`, `node:http`, `node:https`, `node:zlib`, `node:stream`, `node:path`)
- TypeScript types included (`src/index.d.ts`)

## Exports

### `Request` (named export + default export)

```js
import { Request } from 'imagic-request'
// or
import Request from 'imagic-request'
```

### `stream` (named export)

```js
import { stream } from 'imagic-request'
```

---

## `Request(url, options?): Promise<IncomingMessage & { buffer: Buffer }>`

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `url` | `string` | yes | — | Full URL with protocol; `https:` uses `node:https`, everything else uses `node:http` |
| `options` | `object` | no | `{}` | See below |
| `options.method` | `string` | no | `'GET'` | HTTP method |
| `options.headers` | `object` | no | `{}` | Request headers; `Content-Type` for multipart is auto-set when `formData` is present |
| `options.body` | `string \| Buffer` | no | — | Raw body; plain objects throw `Error: body must be a string or Buffer` |
| `options.formData` | `Record<string, string \| Buffer \| ReadableStream>` | no | — | Multipart fields; takes precedence over `body` |
| `options.timeout` | `number` | no | `30000` | Ms before request is destroyed. Set to `0` to disable |
| `options.dns` | `string` | no | — | Custom DNS server IP for hostname resolution |
| `options.maxBodySize` | `number` | no | `0` | Max response body in bytes. `0` = unlimited |
| `options.followRedirects` | `boolean` | no | `true` | Follow 3xx redirects |
| `options.maxRedirects` | `number` | no | `10` | Max redirect chain length |
| `options.retry` | `number` | no | `0` | Number of retries (idempotent methods only) |
| `options.retryDelay` | `number` | no | `1000` | Base delay in ms, doubled each attempt + jitter |
| `options.retryStatusCodes` | `number[]` | no | `[500,502,503,504,408]` | HTTP codes that trigger retry |
| `options.signal` | `AbortSignal` | no | — | Abort signal for request cancellation |
| _...rest_ | any | no | — | Forwarded to `node:http/https`'s `request()` |

**Returns:** `IncomingMessage` with `buffer: Buffer` (full decompressed body).

---

## `stream(url, options?): Promise<{ statusCode, headers, stream }>`

Same options as `Request` (except `retry`, `redirect`, `maxBodySize` — not supported in stream mode).

Returns `{ statusCode, headers, stream }` — a readable stream of the decompressed body, without buffering in memory.

---

## Redirect behavior (RFC 7231)

- 301/302 + POST → changes method to GET, drops body
- 303 + any → changes method to GET, drops body
- 307/308 + any → preserves method and body
- Cross-origin redirects strip `Authorization`, `Cookie`, `Proxy-Authorization` headers

## Retry behavior

- Only idempotent methods: GET, PUT, HEAD, DELETE, OPTIONS, TRACE
- POST is never retried (not idempotent)
- Exponential backoff: `retryDelay * 2^attempt + jitter`
- Retries on network errors (ECONNREFUSED, ECONNRESET, etc.) and retryable status codes

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

### Retry on transient failures

```js
const res = await Request('https://api.example.com/data', {
    retry: 3,
    retryDelay: 1000,
})
```

### Streaming large download

```js
import { stream } from 'imagic-request'
import fs from 'node:fs'

const res = await stream('https://example.com/large-file.zip')
res.stream.pipe(fs.createWriteStream('/tmp/file.zip'))
```

### Custom DNS server

```js
const res = await Request('https://example.com', { dns: '8.8.8.8' })
```

### Abort with signal

```js
const res = await Request('https://example.com', {
    signal: AbortSignal.timeout(5000),
})
```

---

## Constraints / Gotchas

- `body` must be `string` or `Buffer`; plain objects throw synchronously
- Default timeout is 30s; set `timeout: 0` to disable
- HTTP 4xx/5xx responses do **not** reject the promise; check `res.statusCode` manually
- On network error, `err.buffer` contains any bytes received before the failure
- On timeout, rejects with `Error: Request timed out` (no partial buffer)
- Retry only applies to idempotent methods; POST is never retried
- Redirect following is enabled by default (max 10 hops)
- `formData` streams can't be replayed on 307/308 redirect — string/Buffer bodies only
- `stream()` does not support retry, redirect, or maxBodySize

---

## Knowledge Base

**KB tags for this library:** `imagic-request, api`

Before COMPLEX tasks — invoke `knowledge-reader` with tags above + task-specific tags.
After completing a task — if a reusable pattern, error, or decision emerged, invoke `knowledge-writer` with `source: imagic-request`.

See `CLAUDE.md` §Knowledge Base Protocol for the full workflow.
