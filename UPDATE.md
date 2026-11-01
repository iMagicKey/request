# UPDATE — imagic-request

> Audit performed: 2026-04-08. Updated: 2026-11-01. Version at time of audit: 1.1.0

---

## Owner decisions

- [ ] **RQ-07:** 1.1.0 is a MINOR that starts following redirects by default and rejects object bodies. Decide how to handle this in versioning and a changelog. The default behaviour is unchanged.
- [ ] **Default response size limit:** `maxBodySize` still defaults to unlimited, so a hostile server or decompression bomb can exhaust memory. A default limit would be a behaviour change.
- [ ] **Bodies on cross-origin redirects:** a string or Buffer body is sent to the new origin on 307/308 (as the Fetch standard does) and on 301/302 for PUT, PATCH and DELETE. On an https to http 307 it goes in plaintext. Credentials in a body are not stripped.
- [ ] **Header deny-list gaps:** `X-Access-Token`, `Api-Key`, `Private-Token`, `X-CSRF-Token`, `X-Amz-Security-Token`, `X-Goog-Api-Key`, `Authentication`, `Cookie2`, `X-Forwarded-Authorization`, `X-Session-Id` and others still reach another origin. Callers can name them in `sensitiveHeaders`. Decide whether to extend the built-in list.
- [ ] **TLS trust options across origins:** `ca`, `rejectUnauthorized` and `checkServerIdentity` carry over a cross-origin redirect. They are not credentials, but `rejectUnauthorized: false` then applies to a host the caller did not name.

---

## API improvements (minor bump)

- [ ] `formData` with array-form `headers` sends no `Content-Type`, so the server cannot read the form (a local Node server answers 400).

---

## Backlog

- [ ] Redirect following in `stream()`: it returns the 3xx response and ignores `followRedirects` and `maxRedirects`
- [ ] Retry support in `stream()`
- [ ] `maxBodySize` in `stream()`: it is ignored
- [ ] Multipart: when a complete response arrives on a keep-alive connection before the upload has finished, the source stream keeps being read after the promise settles. It stops when the request closes.
- [ ] Multipart: `_write` ignores backpressure, so a large file stream can buffer in memory when the receiver is slow.
- [ ] A response over `maxBodySize` is treated as a network error and retried.
- [ ] A HEAD request that gets a 303 is followed with GET. RFC 9110 keeps HEAD.
- [ ] `tests/request.test.js` "rejects with DNS error for invalid DNS server" sends a query to 192.0.2.1, which is not loopback, and takes most of the suite's run time. `tests/dns.test.js` now covers the option against a loopback server.
- [ ] An invalid header is retried with backoff, as if it were a network error. An invalid URL no longer is.
- [ ] `followRedirects` only disables redirects for exactly `false`: `0`, `''`, `null` and `'false'` all follow.
- [ ] `retry` is not validated: `Infinity` retries until a deadline or abort, 205 attempts in 300 ms with `retryDelay: 0`.
- [ ] Backoff overflow: `retryDelay * 2^attempt + jitter` can exceed the timer maximum, and Node then fires the timer almost immediately.
- [ ] `HTTPS://` in upper case selects `node:http` and rejects with `ERR_INVALID_PROTOCOL`, because the scheme check is case-sensitive.
- [ ] `Content-Encoding: GZIP` and `x-gzip` are not decompressed, because the match is exact and case-sensitive.
- [ ] A gzip response with an empty chunked body rejects with `unexpected end of file`. `Content-Length: 0` is handled.
- [ ] Multipart: a backslash in a field name or filename is sent as is, as the WHATWG encoding specifies, but parsers disagree on it. Python's `email` treats it as an escape, so `name="a\\"; filename="; name=smuggled; x="` can be read differently from undici. See `review-client/08b-backslash.mjs`.
