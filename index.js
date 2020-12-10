const https = require('https');
const http = require('http');
const zlib = require('zlib');
const URL = require('url');

function Request(url, options = {}) {
    let requestOptions = {
        headers: {},
        ...options,
        ...URL.parse(url)
    }

    let requester = requestOptions.protocol == 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        var body = '';

        var request = requester.request(requestOptions, (res) => {

            var output;
            switch (res.headers['content-encoding']) {
                case 'br':
                    var br = zlib.createBrotliDecompress();
                    res.pipe(br);
                    output = br;

                    break;
                
                case 'gzip':
                    var gzip = zlib.createGunzip();
                    output = zlib.createGunzip();
                    res.pipe(gzip);
                    output = gzip;

                    break;

                case 'deflate':
                    var deflate = zlib.createInflate();
                    res.pipe(deflate);
                    output = deflate;

                    break;

                default:
                    output = res;
                    break;
            }

            output.on('data', (data) => {
                data = data.toString('utf-8');
                body += data;
                if (requestOptions.abortAfter) {

                    if (body.length >= requestOptions.abortAfter) {
                        request.abort();

                        return resolve({
                            ...res,
                            body: body
                        });
                    }
                }
            });

            output.on('end', () => {
                if (res.statusCode == 301 || res.statusCode == 302) {
                    if (res.headers.location) {
                        if (res.headers['set-cookie']) {
                            requestOptions.headers.cookie = res.headers['set-cookie'];
                        }

                        return resolve(Request(res.headers.location, requestOptions));
                    }
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject({
                        ...res,
                        body: body
                    })
                }

                return resolve({
                    ...res,
                    body: body
                });
            });
        })

        request.on('error', (err) => {
            return reject({
                ...err,
                body: body
            });
        });

        if (requestOptions.body) {
            request.write(requestOptions.body);
        }

        request.end();
    })
}

module.exports = Request;