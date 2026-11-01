# Domain Research: Node.js HTTP Client Libraries

> Created: 2026-04-08 | Context: imagic-request v1.0.4 improvements

## Domain Overview

This research covers the design space of zero-dependency (or near-zero-dependency) HTTP client
libraries built on Node.js core modules (`node:http`, `node:https`). The goal is to understand what
production-grade HTTP clients do well — especially around timeout granularity, retry logic, response
body limits, redirect following, AbortController integration, and response object design — so
imagic-request can adopt the best patterns without adding any runtime dependencies.

The landscape divides into two tiers: (1) high-level, feature-rich clients like `got` and `undici`
that define the state of the art for API design; and (2) minimal clients like `phin` and the native
`fetch` built into Node.js 21+ that define the floor for what "simple" looks like. imagic-request
sits in the second tier but can selectively adopt patterns from the first.

---

## Key Technologies / Libraries

| Library | Purpose | Popularity | Notes |
|---------|---------|------------|-------|
| `undici` | High-performance HTTP/1.1 + HTTP/2 client; powers Node.js `fetch` | 437M downloads/month (2024) | Written from scratch; bundled in Node.js 18+; WASM llhttp parser |
| `got` | Feature-rich, human-friendly HTTP client | 200M+ downloads/month | Granular timeouts, retry with backoff, hooks lifecycle, `throwHttpErrors` |
| `node-fetch` | Fetch API polyfill for Node.js pre-v18 | Declining (native fetch now built-in) | ~150KB install, no retries, no hooks; essentially obsolete for Node 21+ |
| `phin` | Ultra-lightweight zero-dependency HTTP client | 1.4M/week | 99.8% smaller than `request`; minimal API; no retries/hooks |
| `needle` | Lean but feature-rich HTTP client, 2 deps | Moderate | Streaming, XML/JSON parse, proxy; Node-only |
| `ky` | Fetch wrapper for browser + Node | Growing | Retry built-in, hooks, small; good reference for `fetch` wrapper design |
| `follow-redirects` | Drop-in `http`/`https` replacement with redirect following | 47M/week | Powers axios; `maxRedirects: 21`, `maxBodyLength: 10MB` defaults |
| `axios` | Most popular HTTP client overall | 170M+ weekly | Throws on 4xx/5xx by default; interceptors; no HTTP/2; no built-in retry |

---

## Competitors Analysis

### undici

**Core approach:** Written from scratch, not based on `node:http`. Uses a Dispatcher abstraction
where `Client`, `Pool`, and `Agent` all implement the same interface. Backed by a WASM build of
llhttp (the same HTTP parser Node.js uses internally). Powers native `fetch()` in Node.js 18+.

**Architecture — Dispatcher + Interceptors:**
```js
// undici v6.20+ compose() API
import { Agent, interceptors, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(
    new Agent().compose(
        interceptors.redirect({ maxRedirections: 3 }),
        interceptors.retry({ maxRetries: 3, minTimeout: 1000, timeoutFactor: 2 }),
        interceptors.cache()  // RFC-9111 shared cache
    )
)
// All subsequent fetch() calls go through these interceptors
```

**Timeout options (from Client config):**
- `headersTimeout`: ms to wait for headers after sending request (default: 300s)
- `bodyTimeout`: ms between body chunks before giving up (default: 300s)
- `keepAliveTimeout`: ms idle socket lives in pool (default: 4s)
- `connect.timeout`: TCP connection timeout (default: 10s)

**Response size limit:** `maxResponseSize: -1` (disabled by default). Set to bytes to cap.

**Redirect handling:** Via `interceptors.redirect()` — not built into the core client.

**Strengths:** Maximum performance (+221% vs axios on benchmarks). HTTP pipelining. Pool + queue
management. Clean interceptor composition. MockAgent for testing.

**Weaknesses for imagic-request:** Entire architecture is overkill. The interceptor pattern has
real value but requires a dispatcher abstraction not worth building from scratch.

**Key lesson:** Separating the "connection lifecycle" from the "request/response API" is what makes
undici extensible. For imagic-request, a simpler lesson is that timeout, retry, and redirect should
each be composable concerns, not one monolithic option set.

---

### got

**Core approach:** Promise-based, Node.js-only. Uses `node:http`/`node:https` internally but wraps
them heavily. Most feature-complete client in the Node ecosystem. Retries by default (limit: 2).

**Granular timeouts (the single most important design lesson):**
```
lookup       — socket assigned → hostname resolved (recommended max: 100ms)
connect      — lookup complete → socket fully connected
secureConnect — connect complete → TLS handshake complete (HTTPS only)
socket       — socket connected, resets on new data (equiv. to request.setTimeout)
send         — socket connected → all data written to socket
response     — request flushed → response headers received
request      — total wall-clock time from initiation to response.end event
```
**All default to unlimited.** Each catches a distinct failure mode. A single `timeout` option
misses most of these.

**Retry configuration:**
```js
retry: {
    limit: 2,                          // max retry attempts
    methods: ['GET','PUT','HEAD','DELETE','OPTIONS','TRACE'],  // not POST by default
    statusCodes: [408,413,429,500,502,503,504,521,522,524],
    errorCodes: ['ETIMEDOUT','ECONNRESET','EADDRINUSE','ECONNREFUSED',
                 'EPIPE','ENOTFOUND','ENETUNREACH','EAI_AGAIN'],
    backoffLimit: Infinity,
    noise: 100,                        // ±100ms jitter
    calculateDelay: ({ attemptCount }) => (2 ** (attemptCount - 1)) * 1000 + noise
}
```
The backoff formula: `((2 ** (attemptCount - 1)) * 1000) + noise` gives 1s, 2s, 4s with ±100ms
jitter. Returning `0` from `calculateDelay` aborts the retry.

**Retry-After header support:** `maxRetryAfter` (defaults to `options.timeout.request`). If the
server sends `Retry-After` and the computed wait exceeds `maxRetryAfter`, the request is aborted.

**Redirect behavior:**
```js
followRedirect: true         // default
maxRedirects: 10             // default
```
Implements the RFC 7231 method-change rules: POST + 301/302/303 → GET; POST + 307/308 → POST
preserved. `beforeRedirect` hook available to inspect or cancel.

**`throwHttpErrors: true` (default):** Throws a `got.HTTPError` on any non-2xx response. Set to
`false` to match `fetch` behavior (return the response object). This is the single biggest usability
difference from imagic-request's current behavior (which never throws on 4xx/5xx).

**Hooks lifecycle:**
```
init           — modify normalized options
beforeRequest  — final chance to modify before sending
beforeRedirect — inspect/modify/cancel redirect
beforeRetry    — inspect/modify before a retry attempt
afterResponse  — transform response; can call retryWithMergedOptions()
beforeError    — transform errors into custom classes
```

**Body handling:**
- `body`: raw string/Buffer/stream
- `json`: object → auto-stringify + sets Content-Type: application/json
- `form`: object → URLSearchParams + sets Content-Type: application/x-www-form-urlencoded
- `responseType: 'json' | 'text' | 'buffer'` — auto-parse response

**Strengths:** The most comprehensive API in Node.js. Hooks system is elegant. Granular timeouts
are unique. Retry is production-battle-tested (Renovate uses it for millions of req/day).

**Weaknesses:** Node.js only (not browser compatible). Large package size. ESM-only since v12.

**Key lessons for imagic-request:**
1. The `retry.methods` list must exclude POST by default (idempotency)
2. The `noise` (jitter) on retry delay is essential to prevent thundering herd
3. `throwHttpErrors` as a boolean option covers both use-cases cleanly
4. A single `timeout` maps to got's `socket` timeout — consider adding `response` timeout too

---

### node-fetch

**Core approach:** Minimal Fetch API polyfill. Purpose was browser API compatibility in Node.js
pre-v18. Now essentially obsolete since Node.js 21 has stable native `fetch`.

**What it does right:**
- The Fetch `Response` object design: `{ status, headers, ok, json(), text(), buffer() }` — all
  promise-based body methods prevent the stream-consumption gotcha of raw `IncomingMessage`
- `response.ok` boolean (true when statusCode is 2xx)
- No retry, no hooks, no granular timeouts — keeps scope minimal

**Key lesson:** The `Response` wrapper object is superior to returning raw `IncomingMessage` with
a `buffer` property bolted on. Callers should never see `IncomingMessage` internals.

---

### phin

**Core approach:** "99.8% smaller than request." Zero runtime dependencies. Achieves minimalism
by elimination rather than inclusion.

**API:**
```js
import phin from 'phin'
const res = await phin({
    url: 'https://api.example.com/users',
    method: 'POST',
    data: Buffer.from(JSON.stringify({ name: 'test' })),
    parse: 'json',     // auto-parse response body
    timeout: 5000,
    core: { /* raw http.request options */ }
})
// res.body — parsed body
// res.statusCode
```

**What it has:** Promise/callback dual API, JSON/text response parsing, timeout, custom HTTP
agent via `core` option, `.defaults()` factory for reusable configs, TypeScript types.

**What it excludes by design:** Retry, hooks, cookie jar, redirect following (manual via `core`),
streaming responses, body size limits.

**Key lesson:** The `parse: 'json'` option pattern (explicit parse declaration on the call site) is
cleaner than detecting `Content-Type` automatically. Callers know what they want.

---

### needle

**Core approach:** "Leanest and most handsome HTTP client in the Nodelands." 2 real dependencies.
Feature-richer than phin but leaner than got.

**Notable inclusions vs exclusions:**
- Included: streams (piped responses), XML/JSON auto-parse, proxy support, basic auth,
  multipart/form-data, cookies, `response.body`, `response.statusCode`, `response.headers`
- Excluded: retry, granular timeouts (single `timeout` only), hooks, redirect hooks

**Key lesson:** Streaming responses as a first-class feature (piped `res` without buffering) is
important for large downloads. needle's approach: return the `IncomingMessage` stream optionally.

---

## Design Pattern Analysis: Cross-Library

### 1. Response Object Design

**Current imagic-request:** Mutates `IncomingMessage` by adding `.buffer` property. Anti-pattern.

**Recommended:** Return a clean wrapper object:
```js
{
    statusCode: number,     // e.g. 200
    headers: object,        // response headers
    buffer: Buffer,         // full decompressed body
    // future: ok: boolean, body: string|object (parsed)
}
```
This is safer (no side effects on Node.js internals), testable, and extensible without breaking
the call sites (they already use `res.statusCode`, `res.headers`, `res.buffer`).

---

### 2. Timeout Strategy: Single vs. Granular

**Current imagic-request:** Single `timeout` option mapped to `request.setTimeout()`. This is
equivalent to got's `socket` timeout: fires if no data transferred for N ms. Does not catch:
- Hung DNS lookups (can block libuv threadpool)
- Slow TLS handshake
- Server sends headers but never sends body (only `bodyTimeout` catches this)
- Request takes too long total (only `request` timeout catches this)

**Practical minimum for production:**
```js
// Option 1: keep single timeout (simple, covers most cases)
timeout: 30000   // current approach, add a default

// Option 2: add a second level (covers the main production gap)
timeout: {
    socket: 30000,    // maps to request.setTimeout() — no data for 30s
    response: 10000,  // headers must arrive within 10s after send
}
```
A two-level timeout (socket + response) covers 95% of production failure modes without the
complexity of got's 7-level system.

**Default timeout:** Should be 30000ms (30s), not `undefined`. Hanging requests in production
are a DoS vector and debugging nightmare.

---

### 3. Retry Pattern: Exponential Backoff with Jitter

**The correct implementation:**
```js
// Only retry these methods (idempotency rule)
const RETRY_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])

// Only retry these error codes (transient network failures)
const RETRY_CODES = new Set([
    'ETIMEDOUT', 'ECONNRESET', 'EADDRINUSE', 'ECONNREFUSED',
    'EPIPE', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN'
])

// Only retry these status codes (transient server failures)
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504])

function retryDelay(attempt, baseMs = 1000, maxMs = 10000) {
    const exponential = baseMs * Math.pow(2, attempt - 1)  // 1s, 2s, 4s...
    const jitter = Math.random() * 100                      // ±100ms
    return Math.min(maxMs, exponential + jitter)
}
```

**Key rules:**
- Never retry POST by default (not idempotent — could double-charge)
- Always add jitter to prevent thundering herd (multiple clients retrying simultaneously)
- Cap backoff at `maxMs` (10s is a reasonable ceiling)
- Create a **new** `AbortController` on each retry — once aborted, the signal never resets
- Respect `Retry-After` header: if server says "wait 60s" and your limit is 30s, abort

**Suggested option schema:**
```js
retry: {
    limit: 2,            // default: 0 (disabled, safe default)
    methods: [...],      // default: RETRY_METHODS above
    statusCodes: [...],  // default: RETRY_STATUS above
    backoffBase: 1000,   // ms
    backoffMax: 10000,   // ms
}
```

---

### 4. Response Body Size Limit

**The problem:** A malicious or misbehaving server can send infinite data. Without a `maxBodySize`
limit, a streaming response accumulates into memory until Node.js runs out of heap.

**Implementation pattern (during data event accumulation):**
```js
let totalBytes = 0
output.on('data', (chunk) => {
    totalBytes += chunk.length
    if (options.maxBodySize && totalBytes > options.maxBodySize) {
        request.destroy()
        reject(new Error(`Response body exceeded maxBodySize (${options.maxBodySize} bytes)`))
        return
    }
    buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
})
```

**Defaults from the ecosystem:**
- `follow-redirects` (axios): `maxBodyLength: 10MB` (request), no response limit by default
- `undici`: `maxResponseSize: -1` (disabled)
- Recommended default: no limit by default (`0` = disabled), explicit opt-in

---

### 5. AbortController / AbortSignal Integration

**The modern pattern** (Node.js 15.3+, stable in Node.js 24):
```js
// Pass signal to http.request options
const ac = new AbortController()
const request = requester.request(url, { ...requestOptions, signal: ac.signal }, (res) => { ... })

// Timeout via AbortSignal (preferred over request.setTimeout for new code)
const signal = AbortSignal.timeout(5000)

// Combined timeout + external cancel
const signal = AbortSignal.any([
    AbortSignal.timeout(5000),
    externalController.signal
])

// Error disambiguation
try {
    await Request(url, { signal })
} catch (err) {
    if (err.name === 'TimeoutError') { /* timeout */ }
    else if (err.name === 'AbortError') { /* manual cancel */ }
    else { /* network error */ }
}
```

**Critical rule:** A fired `AbortController` is permanently aborted. Create a **new instance per
retry attempt**. Never reuse an aborted controller.

**Integration approach for imagic-request:**
```js
// Accept signal from caller (for external cancellation)
options.signal    // pass-through to http.request

// Internal timeout via request.setTimeout remains valid for the current implementation
// but AbortSignal.timeout() is the forward-compatible approach
```

---

### 6. Redirect Following

**Node.js `node:http` does NOT follow redirects automatically.** Must be implemented manually.

**The RFC 7231 method-change rules:**
| Status | Method change? | Rule |
|--------|---------------|------|
| 301 | POST → GET allowed (de facto standard) | Permanent, method may change |
| 302 | POST → GET allowed (de facto standard) | Temporary, method may change |
| 303 | Always → GET forced | "See Other" — always GET |
| 307 | Method preserved | Temporary, must not change |
| 308 | Method preserved | Permanent, must not change |

**Implementation skeleton:**
```js
async function followRedirects(url, options, depth = 0) {
    if (depth > (options.maxRedirects ?? 10)) throw new Error('Max redirects exceeded')

    const res = await makeRequest(url, options)

    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const newUrl = new URL(res.headers.location, url).href
        let newMethod = options.method || 'GET'

        // 303 forces GET; 301/302 allow POST→GET (follow historical browser behavior)
        if ([301, 302, 303].includes(res.statusCode) && newMethod === 'POST') {
            newMethod = 'GET'
        }

        const redirectOptions = {
            ...options,
            method: newMethod,
            // On GET redirect, drop the body
            body: newMethod === 'GET' ? undefined : options.body,
            formData: newMethod === 'GET' ? undefined : options.formData,
        }
        return followRedirects(newUrl, redirectOptions, depth + 1)
    }

    return res
}
```

**Defaults from the ecosystem:**
- `follow-redirects`: `maxRedirects: 21`
- `got`: `maxRedirects: 10`
- `undici` interceptor: configurable
- Recommended default: `maxRedirects: 10`, `followRedirects: false` (safe opt-in)

---

### 7. Error Classification

**Three distinct error types — each warrants different handling:**

| Type | Example codes | Source | Retry? |
|------|--------------|--------|--------|
| Network error | `ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN` | TCP/DNS layer | Yes (transient) |
| Timeout error | `ETIMEDOUT`, `Request timed out` | No data within timeout | Yes (transient) |
| HTTP error | `statusCode >= 400` | Server responded | Conditional (5xx yes, 4xx no) |

**Current imagic-request behavior:** All three collapse into `reject(err)`. HTTP errors (4xx/5xx)
are NOT thrown — the promise resolves with the response. This is the `fetch` pattern.

**Design decision:** Whether to throw on 4xx/5xx (`got`/`axios` pattern) or return (`fetch`/phin
pattern) is a user-preference. `throwHttpErrors: false` (default) matches current behavior and
is safer for API callers who need to inspect error bodies. Could add `throwHttpErrors: true` opt-in.

**For retry logic:** Network errors and `ETIMEDOUT` should be retried. HTTP 4xx should never be
retried (client error). HTTP 5xx/429 may be retried with backoff.

---

### 8. Streaming vs. Buffered Responses

**Current imagic-request:** Always buffers the full response into `res.buffer`. Correct for small
payloads. Wrong for large downloads (videos, bulk exports, proxying).

**Pattern for streaming support:**
```js
// Option A: streaming mode via option flag
const res = await Request(url, { stream: true })
// Returns the raw IncomingMessage/decompressed stream
// Caller responsible for piping and error handling

// Option B: separate function
import { RequestStream } from 'imagic-request'
const stream = await RequestStream(url, options)
stream.pipe(fs.createWriteStream('/tmp/output'))
```

**Use `stream.pipeline()` not `.pipe()`** in internal implementations — pipeline properly
propagates errors and cleans up all streams on failure.

**Memory concern:** Without `maxBodySize`, even the buffered mode is an OOM risk. With streaming,
the concern moves to the caller but is explicitly their responsibility.

---

### 9. DNS Resolution Options

**Current imagic-request:** No DNS control. Uses `dns.lookup()` (the default in `node:http`).

**The problem with `dns.lookup()`:**
- Uses libuv's threadpool (limited to 4 threads by default)
- Blocks the threadpool under high concurrency
- Uses system resolver (no per-request DNS server control)
- `localAddress` binding does NOT affect DNS lookup (known Node.js issue)

**The production pattern:**
```js
import dns from 'node:dns'
const resolver = new dns.Resolver()
resolver.setServers(['8.8.8.8', '1.1.1.1'])

// Pass custom lookup to http.request
const request = http.request(url, {
    lookup: (hostname, options, callback) => {
        resolver.resolve4(hostname, (err, addresses) => {
            if (err) return callback(err)
            callback(null, addresses[0], 4)
        })
    }
}, callback)
```

**`options.lookup` in imagic-request:** Pass a custom lookup function directly to `http.request`.
This is already supported implicitly since imagic-request passes `...rest` to `requester.request()`.
The UPDATE.md task to "Implement `dns` option" can be satisfied by documenting that the existing
`options.lookup` pass-through already works.

---

## Best Practices Found

1. **Always set a default timeout** — hanging requests are a DoS vector; `30000ms` is a reasonable
   production default — [betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts](https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/)

2. **Retry only idempotent methods** (GET, HEAD, PUT, DELETE, OPTIONS, PATCH, not POST) — [got retry docs](https://github.com/sindresorhus/got/blob/main/documentation/7-retry.md)

3. **Always add jitter to retry backoff** — prevents thundering herd when multiple clients hit the
   same failed endpoint — [betterstack AbortController guide](https://betterstack.com/community/guides/scaling-nodejs/understanding-abortcontroller/)

4. **Create a new `AbortController` per retry attempt** — a fired signal never resets — [nearform AbortSignal](https://nearform.com/insights/using-abortsignal-in-node-js/)

5. **Separate `maxBodySize` for response** — cap response size to prevent OOM from malicious
   servers — [follow-redirects npm](https://www.npmjs.com/package/follow-redirects)

6. **Use `stream.pipeline()` over `.pipe()`** — pipeline propagates errors and prevents stream
   leaks — [DEV streaming middleware](https://dev.to/hexshift/streaming-middleware-in-nodejs-transform-large-http-responses-without-buffering-2c4p)

7. **Return a clean wrapper object** not mutated `IncomingMessage` — prevents accidental coupling
   to Node.js internals — [HTTP client patterns](https://agentfactory.panaversity.org/docs/TypeScript-Language-Realtime-Interaction/runtime-environments-http/http-client-patterns)

8. **For 303 redirects: force GET** regardless of original method; for 307/308: preserve method —
   [redirect guide](https://www.301check.com/en/guides/redirect-guide.html)

9. **Validate `body` is not a plain object** — silently calling `.toString()` on `{}` produces
   `[object Object]`, a common and silent bug — observed in imagic-request UPDATE.md

10. **Respect `Retry-After` header** — if server says wait 60s and max timeout is 30s, abort
    instead of retrying — [got retry docs](https://github.com/sindresorhus/got/blob/main/documentation/7-retry.md)

---

## Common Pitfalls

1. **Single `timeout` option misses the response-stall failure mode** — a server can accept the
   connection, send headers immediately, then stall the body indefinitely. A single
   `request.setTimeout()` only fires if NO data arrives; body stall is invisible to it. Solution:
   add a separate `bodyTimeout` or `response` timeout at the response level (track bytes received
   in `data` handler, reset a timer on each chunk).

2. **Retrying POST requests** — POST is not idempotent; retrying can create duplicate records,
   double charges, etc. Many developers cargo-cult retry logic from GET contexts. Fix: explicitly
   check method before retrying.

3. **Reusing an `AbortController` across retries** — once `.abort()` is called, the signal is
   permanently `aborted: true`. All subsequent requests using the same signal abort immediately.
   Fix: `new AbortController()` on each retry iteration.

4. **`Promise.race()` for timeouts** — the losing promise keeps running silently, consuming
   resources. Fix: use `AbortController.abort()` to actually cancel the in-flight request.

5. **Buffering without size limit** — `buffers.push(chunk)` in a data handler has no ceiling.
   A server sending 10GB of data will crash the Node.js process. Fix: `maxBodySize` check in
   data handler.

6. **Not validating `body` type** — passing a plain object as `body` calls `.toString()` on it,
   sending `[object Object]` to the server. Most servers return 400 but the error is opaque.
   Fix: throw `TypeError` if `body` is a plain object; document that callers must `JSON.stringify`.

7. **`maxRedirects` without method-change logic** — naively re-requesting the redirect URL with
   the original method violates RFC 7231 for 301/302/303. Fix: implement the method-change table.

8. **Not destroying the socket on timeout** — calling `request.destroy()` on timeout is correct
   (current imagic-request does this). Failing to do so leaves the socket open and can exhaust
   the file descriptor limit.

9. **Circular redirect loops** — `example.com → /redirect → example.com → /redirect → ...`
   Without a `maxRedirects` cap this loops forever. Fix: always enforce a redirect count limit.

10. **Compression stream error not propagated** — if `zlib.createGunzip()` encounters corrupt
    data, it emits an `error` event. If the error handler on the decompressed stream isn't wired
    up, it crashes the process with an unhandled exception. Current imagic-request handles this
    via `output.on('error', ...)`.

---

## Recommended Additions for imagic-request (Priority Order)

Based on research, ranked by production impact:

### MINOR bump (non-breaking additions)

**1. Default timeout** (highest impact, zero API change)
```js
// Add default in options processing:
const timeout = requestOptions.timeout ?? 30000
```

**2. Wrapper return object** (breaking change to `res.buffer` callers — plan carefully)
```js
return resolve({
    statusCode: res.statusCode,
    headers: res.headers,
    buffer: Buffer.concat(buffers),
})
```

**3. Body type validation** (prevents silent `[object Object]` bug)
```js
if (requestOptions.body !== undefined &&
    typeof requestOptions.body === 'object' &&
    !Buffer.isBuffer(requestOptions.body)) {
    throw new TypeError('options.body must be a string or Buffer. Use JSON.stringify() for objects.')
}
```

**4. `maxBodySize` option** (OOM protection)
```js
let totalBytes = 0
output.on('data', (chunk) => {
    totalBytes += chunk.length
    if (options.maxBodySize > 0 && totalBytes > options.maxBodySize) {
        request.destroy()
        return reject(new Error(`Response body exceeded maxBodySize limit`))
    }
    buffers.push(...)
})
```

**5. `signal` option** (AbortController integration)
Pass through `options.signal` to `requester.request()` — it's already partially supported via
`...rest` spread. Needs explicit documentation and error handling for `AbortError`.

**6. `retry` option** (network resilience)
```js
retry: {
    limit: 0,            // default: 0 (disabled — safe default)
    methods: ['GET','HEAD','PUT','DELETE','OPTIONS','PATCH'],
    statusCodes: [408,429,500,502,503,504],
    backoffBase: 1000,
    backoffMax: 10000,
}
```

**7. `followRedirects` option** (RFC-compliant redirect following)
```js
followRedirects: false,  // default: false (safe default, matches current behavior)
maxRedirects: 10,
```

### MAJOR bump (API-breaking changes)

**8. Streaming response mode** — return the decompressed stream instead of buffering:
```js
// Only if stream: true is passed
const { stream: returnStream } = options
if (returnStream) return resolve({ statusCode: res.statusCode, headers: res.headers, stream: output })
```

**9. TypeScript types** — `.d.ts` declaration file

---

## Recommended Tech Stack

Primary: `node:http`, `node:https`, `node:zlib`, `node:stream`, `node:path` (all already in use)
Additional built-ins: `node:dns` (for DNS documentation), `node:timers/promises` (for retry sleep)

No new runtime dependencies should be added. The zero-dependency constraint is correct and should
be maintained. Every feature listed above is achievable with Node.js 24 built-ins.

```js
// Retry sleep using built-in timers
import { setTimeout as sleep } from 'node:timers/promises'

async function retryableRequest(url, options, attempt = 1) {
    try {
        return await Request(url, options)
    } catch (err) {
        const retryOpts = options.retry || {}
        const limit = retryOpts.limit ?? 0
        if (attempt > limit) throw err

        const method = (options.method || 'GET').toUpperCase()
        if (!RETRY_METHODS.has(method)) throw err
        if (!RETRY_CODES.has(err.code) && !RETRY_STATUS.has(err.statusCode)) throw err

        const delay = retryDelay(attempt, retryOpts.backoffBase, retryOpts.backoffMax)
        await sleep(delay)
        return retryableRequest(url, options, attempt + 1)
    }
}
```

---

## Unknown / Needs Clarification

1. **Wrapper return object backward compatibility** — changing from `IncomingMessage + .buffer`
   to a plain `{ statusCode, headers, buffer }` object is a MINOR or MAJOR bump depending on
   whether callers use `IncomingMessage`-specific methods (e.g., `.pipe()`, `.read()`). Needs
   audit of all imagic-request consumers across the monorepo before deciding.

2. **Should `retry: { limit: 0 }` be the default or should retry be absent by default?** — Both
   are safe. `limit: 0` is more explicit. Recommend `limit: 0` to make the opt-in obvious.

3. **`followRedirects` default** — `got` defaults to `true`; `phin`/`node-fetch` default to
   `false` (return the 3xx response). For a library used in API scraping contexts, `false` is
   safer. Needs operator decision.

4. **The `dns` UPDATE.md task** — research shows the existing `...rest` spread already passes
   a custom `lookup` function through to `node:http`. The task may already be done implicitly.
   Needs a test to confirm `options.lookup` works today.

---

## Sources

- [undici GitHub](https://github.com/nodejs/undici)
- [undici Client API](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)
- [undici v7 release notes](https://blog.platformatic.dev/undici-v7-is-here)
- [undici fundamentals blog](https://blog.platformatic.dev/http-fundamentals-understanding-undici-and-its-working-mechanism)
- [undici — Leapcell article](https://leapcell.io/blog/unpacking-node-js-s-built-in-fetch-and-its-undici-foundation)
- [got GitHub](https://github.com/sindresorhus/got)
- [got retry documentation](https://github.com/sindresorhus/got/blob/main/documentation/7-retry.md)
- [got timeout documentation](https://github.com/sindresorhus/got/blob/main/documentation/6-timeout.md)
- [got options reference](https://github.com/sindresorhus/got/blob/main/documentation/2-options.md)
- [got npm page](https://www.npmjs.com/package/got)
- [phin GitHub (LuminescentMoon)](https://github.com/LuminescentMoon/phin)
- [phin npm](https://www.npmjs.com/package/phin)
- [needle LogRocket tutorial](https://blog.logrocket.com/using-needle-send-http-requests-nodejs/)
- [follow-redirects npm](https://www.npmjs.com/package/follow-redirects)
- [follow-redirects GitHub](https://github.com/follow-redirects/follow-redirects)
- [AbortController in Node.js — AppSignal](https://blog.appsignal.com/2025/02/12/managing-asynchronous-operations-in-nodejs-with-abortcontroller.html)
- [AbortController — nearform](https://nearform.com/insights/using-abortsignal-in-node-js/)
- [AbortController — betterstack](https://betterstack.com/community/guides/scaling-nodejs/understanding-abortcontroller/)
- [Node.js timeouts — betterstack](https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/)
- [Timeout + retry patterns — tasukehub](https://tasukehub.com/articles/nodejs-fetch-timeout-retry-guide?lang=en)
- [HTTP redirect guide 301/302/303/307/308](https://www.301check.com/en/guides/redirect-guide.html)
- [HTTP redirect RFC 7231 analysis](https://www.oreateai.com/blog/indepth-analysis-of-http-redirect-status-codes-technical-details-and-evolution-of-301-302-303-307-and-308/c7ff12d8cc63ac56f6643753187b0cb3)
- [throwHttpErrors pattern — LogRocket axios vs fetch](https://blog.logrocket.com/axios-vs-fetch-2025/)
- [Top 5 HTTP libraries — AppSignal 2024](https://blog.appsignal.com/2024/09/11/top-5-http-request-libraries-for-nodejs.html)
- [Streaming middleware in Node.js — DEV](https://dev.to/hexshift/streaming-middleware-in-nodejs-transform-large-http-responses-without-buffering-2c4p)
- [Node.js DNS configuration — httptoolkit](https://httptoolkit.com/blog/configuring-nodejs-dns/)
- [Error handling in Node.js API clients — freecodecamp](https://www.freecodecamp.org/news/how-to-gracefully-handle-failures-in-a-node-js-api-client-605673cb72ab)
- [Node.js DNS documentation v24](https://nodejs.org/docs/latest-v24.x/api/dns.html)
