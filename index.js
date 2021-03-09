const https = require('https')
const http = require('http')
const zlib = require('zlib')

function Request(url, options = {}) {
    let requestOptions = {
        headers: {},
        ...options,
    }
 
    let requester = url.indexOf('https:') != -1 ? https : http

    return new Promise((resolve, reject) => {
        let buffers = []
        
        let request = requester.request(url, requestOptions, (res) => {

            let output
            switch (res.headers['content-encoding']) {
                case 'br':
                    let br = zlib.createBrotliDecompress()
                    res.pipe(br)
                    output = br

                    break
                
                case 'gzip':
                    let gzip = zlib.createGunzip()
                    output = zlib.createGunzip()
                    res.pipe(gzip)
                    output = gzip

                    break

                case 'deflate':
                    let deflate = zlib.createInflate()
                    res.pipe(deflate)
                    output = deflate

                    break

                default:
                    output = res
                    break
            }

            output.on('data', (data) => {
                buffers.push(Buffer.from(data, 'binary'))
            })

            output.on('end', () => {
                return resolve({
                    ...res,
                    buffer: Buffer.concat(buffers)
                })
            })
        })

        request.on('error', (err) => {
            return reject({
                ...err,
                buffer: Buffer.concat(buffers)
            })
        })

        if (requestOptions.body) {
            request.write(requestOptions.body)
        }

        request.end()
    })
}

module.exports = Request