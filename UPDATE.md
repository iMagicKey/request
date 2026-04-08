# UPDATE — imagic-request

> Audit performed: 2026-04-07. Version at time of audit: 1.0.4

---

## Fixed (2026-04-07)

- [x] **Boundary generation** — `Math.random() * 10` produced only digits 0-9, changed to `* 16` for full hex range (0-f)
- [x] **Lint warnings** — replaced `for..in` with `Object.entries()` in multipartform.js, fixed default import in test

---

## API improvements (minor bump)

- [ ] **Default timeout** — add `options.timeout` with a default value (e.g., 30000ms) to prevent hanging requests in production
- [ ] **`maxBodySize` option** — limit response size to prevent OOM from malicious servers
- [ ] **`retry` option** — `{ retry: 3, retryDelay: 1000 }` for automatic retries on network errors
- [ ] **Wrapper return object** — instead of mutating the raw `res`, return `{ statusCode, headers, buffer, body }`. Currently `res.buffer` is added to the Node.js response object, which is a side-effect
- [ ] **Request body validation** — if `body` is an object, it currently silently sends `[object Object]`. Should throw an error or automatically `JSON.stringify`
- [ ] **Implement `dns` option** — use `dns.lookup` / `dns.resolve` with a custom server

---

## Backlog

- [ ] Support `AbortController` / `AbortSignal` for request cancellation
- [ ] Support redirect following (currently missing)
- [ ] Export TypeScript types
- [ ] Support streamed responses (without buffering in memory)
