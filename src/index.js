import http from 'http'
import https from 'https'
import zlib from 'zlib'
import createMultipartForm from './modules/multipartform.js'

export default async function Request(url = '', options = {}) {
    if (typeof url !== 'string') throw new Error('URL must be a string')
    if (typeof options !== 'object') throw new Error('Options must be an object')

    let requestOptions = {
        headers: {},
        ...options,
    }

    if (requestOptions.formData) {
        let formData = createMultipartForm(requestOptions.formData)
        requestOptions.formData = formData.dataStream
        requestOptions.headers = requestOptions.headers || {}
        requestOptions.headers['Content-Type'] = `multipart/form-data; boundary=${formData.boundary}`
    }

    let requester = url.startsWith('https:') ? https : http

    return new Promise(async (resolve, reject) => {
        let buffers = []

        let request = requester.request(url, requestOptions, async (res) => {
            let output
            switch (res.headers['content-encoding']) {
                case 'br':
                    output = res.pipe(zlib.createBrotliDecompress())
                    break
                case 'gzip':
                    output = res.pipe(zlib.createGunzip())
                    break
                case 'deflate':
                    output = res.pipe(zlib.createInflate())
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

        request.on('timeout', () => {
            request.destroy()
            return reject(new Error('Request timed out'))
        })

        request.on('error', (err) => {
            err.buffer = Buffer.concat(buffers)
            return reject(err)
        })

        if (requestOptions.timeout) {
            request.setTimeout(requestOptions.timeout)
        }

        let requestData = requestOptions.formData || requestOptions.body
        if (requestData) {
            if (requestData.readable) {
                requestData.pipe(request)
                requestData.on('finish', () => {
                    request.end()
                })
            } else {
                request.end(requestData)
            }
        } else {
            request.end()
        }
    })
}
