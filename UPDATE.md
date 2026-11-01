# UPDATE — imagic-request

> Audit performed: 2026-04-08. Updated: 2026-11-01. Version at time of audit: 1.1.0

---

## Owner decisions

- [ ] **RQ-07:** 1.1.0 is a MINOR that starts following redirects by default and rejects object bodies. Decide how to handle this in versioning and a changelog. The default behaviour is unchanged.
- [ ] **Default response size limit:** `maxBodySize` still defaults to unlimited, so a hostile server or decompression bomb can exhaust memory. A default limit would be a behaviour change.
- [ ] **Bodies on cross-origin 307/308:** a string or Buffer body is sent to the new origin, as the Fetch standard does. Credentials in a body are not stripped.
- [ ] **TLS trust options across origins:** `ca`, `rejectUnauthorized` and `checkServerIdentity` carry over a cross-origin redirect. They are not credentials, but `rejectUnauthorized: false` then applies to a host the caller did not name.

---

## API improvements (minor bump)

- [ ] `formData` with array-form `headers` sends no `Content-Type`, so the server cannot read the form (a local Node server answers 400).

---

## Backlog

- [ ] Redirect following in `stream()`
- [ ] Retry support in `stream()`
- [ ] Multipart: a field stream destroyed part-way without an error never finishes the form. With `timeout: 0` and no `deadline` the request hangs. `stream.finished` would cover this.
- [ ] Multipart: a field stream that has already been consumed is sent as the text `[object Object]`.
- [ ] Multipart: `_write` ignores backpressure, so a large file stream can buffer in memory when the receiver is slow.
- [ ] A response over `maxBodySize` is treated as a network error and retried.
- [ ] A HEAD request that gets a 303 is followed with GET. RFC 9110 keeps HEAD.
- [ ] `tests/request.test.js` "rejects with DNS error for invalid DNS server" sends a query to 192.0.2.1, which is not loopback, and takes most of the suite's run time. `tests/dns.test.js` now covers the option against a loopback server.
