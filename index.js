const https = require('https')
const http = require('http')
const zlib = require('zlib')

const FormData = require('./modules/multipartform')

function Request(url, options = {}) {
    let requestOptions = {
        headers: {},
        ...options,
    }

    if (requestOptions.formData) {
        let formData = FormData(requestOptions.formData)
        requestOptions.formData = formData.dataStream
        requestOptions.headers = requestOptions.headers ||  {}
        requestOptions.headers['Content-Type'] = `multipart/form-data; boundary=${formData.boundary}`
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
                res.buffer = Buffer.concat(buffers)
                return resolve(res)
            })
        })

        request.on('error', (err) => {
            err.buffer = Buffer.concat(buffers)
            return reject(err)
        })

        let requestData = requestOptions.formData || requestOptions.body
        if (requestData) {
            if (requestData.readable) {
                requestData.pipe(request)
                requestData.on('finish', () => {
                    request.end()
                })
            } else {
                if (typeof requestData == 'string' || requestData instanceof Buffer || requestData instanceof Uint8Array) {
                    request.write(requestData)
                }
                request.end()
            }
        } else {
            request.end()
        }
    })
}

module.exports = Request