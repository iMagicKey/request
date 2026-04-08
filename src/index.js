import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import createMultipartForm from './modules/multipartform.js'

async function Request(url = '', options = {}) {
    if (typeof url !== 'string') throw new Error('URL must be a string')
    if (typeof options !== 'object' || options === null) throw new Error('Options must be an object')

    const requestOptions = {
        headers: {},
        ...options,
    }

    if (requestOptions.formData) {
        const formData = createMultipartForm(requestOptions.formData)
        requestOptions.formData = formData.dataStream
        requestOptions.headers = requestOptions.headers || {}
        requestOptions.headers['Content-Type'] = `multipart/form-data; boundary=${formData.boundary}`
    }

    const requester = url.startsWith('https:') ? https : http

    return new Promise((resolve, reject) => {
        const buffers = []

        const request = requester.request(url, requestOptions, (res) => {
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
                buffers.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
            })

            output.on('end', () => {
                res.buffer = Buffer.concat(buffers)
                return resolve(res)
            })

            output.on('error', (err) => {
                err.buffer = Buffer.concat(buffers)
                return reject(err)
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

        const requestData = requestOptions.formData || requestOptions.body
        if (requestData) {
            if (requestData.readable) {
                requestData.on('error', (err) => {
                    request.destroy()
                    reject(err)
                })
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

export { Request }
export default Request
