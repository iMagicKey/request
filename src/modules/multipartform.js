import { randomBytes } from 'node:crypto'
import { Duplex, Readable } from 'node:stream'
import path from 'node:path'

/** WHATWG multipart/form-data escaping for field names and filenames. */
function escapeName(name) {
    return name.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

const isStream = (value) => typeof value?.pipe === 'function' && typeof value.on === 'function'
const typeName = (value) => (value === null ? 'null' : (value?.constructor?.name ?? typeof value))

function isPlainObject(value) {
    if (typeof value !== 'object' || value === null) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || Object.getPrototypeOf(prototype) === null
}

/** Return the problem with a field value, or undefined. Other types would reach the wire as text like `[object Blob]`. */
function findProblem(value) {
    if (['string', 'number', 'boolean', 'bigint'].includes(typeof value) || value instanceof Uint8Array) return undefined
    if (value instanceof ReadableStream) return value.locked ? 'is a locked ReadableStream' : undefined
    if (isStream(value)) return value.destroyed || value.readable === false ? 'is a stream that has already been consumed or destroyed' : undefined
    return `has the unsupported type ${typeName(value)}. Use a string, number, boolean, Buffer, Uint8Array or readable stream`
}

/** Check every field before anything is sent, and convert web streams. On failure, no stream is left open or unguarded. */
function readFields(fields) {
    if (!isPlainObject(fields)) throw new TypeError(`formData must be a plain object of field names and values, not ${typeName(fields)}`)

    const entries = Object.entries(fields)
    const invalid = entries.find(([, value]) => findProblem(value))
    if (invalid) {
        for (const [, value] of entries) {
            if (!isStream(value)) continue
            value.on('error', () => {})
            value.destroy?.()
        }
        throw new TypeError(`formData field "${invalid[0]}" ${findProblem(invalid[1])}`)
    }
    return entries.map(([name, value]) => [name, value instanceof ReadableStream ? Readable.fromWeb(value) : value])
}

export default function createMultipartForm(rawFields) {
    const fields = readFields(rawFields)
    const dataStream = new Duplex()
    let reading = false
    const defaultMimeType = 'application/octet-stream'

    const boundary = `-----${randomBytes(12).toString('hex')}`

    // Every stream gets a listener now, not when its field is reached: a stream can fail while an earlier
    // field is still being sent, and an 'error' with no listener would take the process down. The listeners
    // stay in place, so an error arriving after the form has ended is ignored.
    const fieldStreams = fields.map(([, value]) => value).filter(isStream)
    const fail = (err) => dataStream.destroy(err)
    for (const stream of fieldStreams) {
        let ended = false
        stream.on('error', fail)
        stream.once('end', () => {
            ended = true
        })
        stream.once('close', () => {
            if (!ended) fail(new Error('A formData stream closed before it ended'))
        })
    }
    // A form failure reaches the request through its own listener on the form. A form that has none must not crash.
    dataStream.on('error', () => {})
    dataStream.once('close', () => {
        for (const stream of fieldStreams) stream.destroy?.()
    })

    function getFileMimeType(filepath) {
        const mimeTypes = {
            json: 'application/json',
            pdf: 'application/pdf',
            zip: 'application/zip',
            gzip: 'application/gzip',
            rar: 'application/x-rar-compressed',
            tar: 'application/x-tar',
            torrent: 'application/x-bittorrent',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
            ppt: 'application/vnd.ms-powerpoint',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            dvi: 'application/x-dvi',
            ttf: 'application/x-font-ttf',
            p12: 'application/x-pkcs12',
            pfx: 'application/x-pkcs12',
            p7b: 'application/x-pkcs7-certificates',
            spc: 'application/x-pkcs7-certificates',
            p7r: 'application/x-pkcs7-certreqresp',
            p7c: 'application/x-pkcs7-mime',
            p7m: 'application/x-pkcs7-mime',
            p7s: 'application/x-pkcs7-signature',
            mp3: 'audio/mpeg',
            aac: 'audio/aac',
            ogg: 'audio/ogg',
            gif: 'image/gif',
            jpeg: 'image/jpeg',
            jpg: 'image/jpeg',
            png: 'image/png',
            svg: 'image/svg+xml',
            tiff: 'image/tiff',
            ico: 'image/vnd.microsoft.icon',
            wbmp: 'image/vnd.wap.wbmp',
            cmd: 'text/cmd',
            css: 'text/css',
            csv: 'text/csv',
            html: 'text/html',
            js: 'text/javascript',
            txt: 'text/plain',
            php: 'text/php',
            xml: 'text/xml',
            mpeg: 'video/mpeg',
            mp4: 'video/mp4',
            webm: 'video/webm',
            flv: 'video/x-flv',
            avi: 'video/x-msvideo',
            '3gpp': 'video/3gpp',
            '3gp': 'video/3gpp',
            '3gpp2': 'video/3gpp2',
            '3g2': 'video/3gpp2',
        }

        const ext = path.extname(filepath).slice(1)
        if (Object.hasOwn(mimeTypes, ext)) return mimeTypes[ext]
        return defaultMimeType
    }

    function pushField(fieldName, fieldData) {
        return new Promise((resolve) => {
            dataStream.push(Buffer.from(boundary, 'utf8'))

            if (isStream(fieldData)) {
                let mimeType = defaultMimeType
                let filename = 'filename'

                if (fieldData.path) {
                    mimeType = getFileMimeType(fieldData.path)
                    filename = path.basename(fieldData.path)
                }

                dataStream.push(Buffer.from(`\r\nContent-Disposition: form-data; name="${escapeName(fieldName)}"; filename="${escapeName(filename)}"`, 'utf8'))
                dataStream.push(Buffer.from(`\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'))

                fieldData.pipe(dataStream, { end: false })
                fieldData.on('end', () => {
                    dataStream.push(Buffer.from(`\r\n`))
                    resolve()
                })
            } else {
                dataStream.push(Buffer.from(`\r\nContent-Disposition: form-data; name="${escapeName(fieldName)}"\r\n\r\n`, 'utf8'))
                // Buffers and typed arrays go on the wire as they are; anything else is text.
                if (fieldData instanceof Uint8Array) {
                    if (fieldData.length > 0) dataStream.push(Buffer.from(fieldData.buffer, fieldData.byteOffset, fieldData.byteLength))
                } else {
                    dataStream.push(Buffer.from(fieldData.toString(), 'utf8'))
                }
                dataStream.push(Buffer.from('\r\n'))
                resolve()
            }
        })
    }

    dataStream._read = () => {
        if (reading === false) {
            reading = true
            ;(async () => {
                for (const [fieldName, fieldValue] of fields) {
                    await pushField(fieldName, fieldValue)
                    if (dataStream.destroyed) return
                }
                dataStream.push(Buffer.from(`${boundary}--`, 'utf8'))
                dataStream.push(null)
            })().catch((err) => dataStream.destroy(err))
        }
    }

    dataStream._write = (chunk, encoding, callback) => {
        dataStream.push(chunk)
        callback()
    }

    return { dataStream, boundary: boundary.slice(2) }
}
