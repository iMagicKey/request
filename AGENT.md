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
| `options.formData` | `Record<string, string \| Buffer \| ReadableStream>` | no | — | Multipart fields; takes precedence over `body`. Strings and Buffers are plain fields (Buffers as exact bytes); streams are file parts |
| `options.timeout` | `number` | no | `30000` | Socket idle time in ms before the request is destroyed, per hop. A slow but steady response never trips it. Set to `0` to disable |
| `options.deadline` | `number` | no | `0` | Total limit in ms across connecting, redirects, retries, backoff and body. `0` = none. Rejects with `name: 'TimeoutError'`, `code: 'ETIMEDOUT'` |
| `options.dns` | `string` | no | — | Custom DNS server IP (optionally `ip:port`) for hostname resolution. IPv4 (A records) only |
| `options.maxBodySize` | `number` | no | `0` | Max response body in bytes. `0` = unlimited |
| `options.followRedirects` | `boolean` | no | `true` | Follow 3xx redirects |
| `options.maxRedirects` | `number` | no | `10` | Max redirect chain length. Exceeding it rejects; `0` rejects on any redirect. Use `followRedirects: false` to receive the 3xx response |
| `options.sensitiveHeaders` | `string[]` | no | `[]` | Extra header names (case-insensitive) removed when a redirect changes origin |
| `options.retry` | `number` | no | `0` | Number of retries (idempotent methods only) |
| `options.retryDelay` | `number` | no | `1000` | Base delay in ms, doubled each attempt + jitter. `0` retries with no delay |
| `options.retryStatusCodes` | `number[]` | no | `[500,502,503,504,408]` | HTTP codes that trigger retry |
| `options.signal` | `AbortSignal` | no | — | Abort signal for request cancellation. An aborted request rejects promptly and is never retried |
| _...rest_ | any | no | — | Forwarded to `node:http/https`'s `request()` |

**Returns:** `IncomingMessage` with `buffer: Buffer` (full decompressed body).

---

## `stream(url, options?): Promise<{ statusCode, headers, stream }>`

Same options as `Request` (except `retry`, `followRedirects`/`maxRedirects`, `maxBodySize` — not supported in stream mode). `body` and `formData` are sent. `deadline` also covers reading the body: the returned stream errors if it has not finished in time.

Returns `{ statusCode, headers, stream }` — a readable stream of the decompressed body, without buffering in memory.

---

## Redirect behavior (RFC 7231)

- 301/302 + POST → changes method to GET, drops body
- 303 + any → changes method to GET, drops body
- 307/308 + any → preserves method and body
- A redirect that changes scheme, host or port removes, case-insensitively, `Authorization`, `Cookie`, `Proxy-Authorization`, `Host`, `X-Api-Key`, `X-Auth-Token` and any `sensitiveHeaders`
- It also drops `auth`, client certificate and TLS credential options (`cert`, `key`, `pfx`, `passphrase`, `secureContext`, `session`, ...), `servername`, `agent`, `createConnection` and `socketPath`. A custom `agent` (including a proxy agent) is therefore not used after an origin change
- Credentials removed this way stay removed if a later redirect returns to the original origin. Same-origin redirects keep them. A retry starts again from the original URL with the original options
- Redirects to anything other than `http:` or `https:` are refused with an error

## Retry behavior

- Only idempotent methods: GET, PUT, HEAD, DELETE, OPTIONS, TRACE
- POST is never retried (not idempotent)
- Exponential backoff: `retryDelay * 2^attempt + jitter`
- Retries on network errors (ECONNREFUSED, ECONNRESET, etc.) and retryable status codes
- Never retries after the signal aborts, or when the body is `formData` (a stream, which cannot be sent twice)

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
- Default timeout is 30s of socket inactivity, not a total limit; set `timeout: 0` to disable. Use `deadline` for a total limit
- `maxBodySize` defaults to unlimited, so a hostile server can exhaust memory unless it is set
- HTTP 4xx/5xx responses do **not** reject the promise; check `res.statusCode` manually
- Errors never carry the request URL: an invalid URL or `Location` rejects with a fresh error, without Node's `input` and `base` properties
- On network error, `err.buffer` contains any bytes received before the failure
- On timeout, rejects with `Error: Request timed out` (no partial buffer)
- A 101 protocol switch or any reply to `CONNECT` rejects with `Unexpected <status> response`, and its socket is destroyed: upgrades and tunnels are not supported
- A truncated or malformed compressed body rejects (`stream()`: errors the returned stream). Responses without a body (HEAD, 204, 304, `Content-Length: 0`) are not decompressed
- Retry only applies to idempotent methods; POST is never retried
- Redirect following is enabled by default (max 10 hops)
- `formData` is sent as a stream and can't be replayed: a redirect that keeps the body (307/308, or 301/302 on a non-POST) rejects with `Cannot follow ... redirect`. String and Buffer bodies are replayed
- `stream()` does not support retry, redirect, or maxBodySize

---

## Knowledge Base

**KB tags for this library:** `imagic-request, api`

Before COMPLEX tasks — invoke `knowledge-reader` with tags above + task-specific tags.
After completing a task — if a reusable pattern, error, or decision emerged, invoke `knowledge-writer` with `source: imagic-request`.

See `CLAUDE.md` §Knowledge Base Protocol for the full workflow.
