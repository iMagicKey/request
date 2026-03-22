import { Duplex } from 'node:stream'
import path from 'node:path'

export default function createMultipartForm(fields) {
    let dataStream = new Duplex()
    let reading = false
    let defaultMimeType = 'application/octet-stream'

    let boundary = '-----'
    for (let i = 0; i < 24; i++) {
        boundary += Math.floor(Math.random() * 10).toString(16)
    }

    function getFileMimeType(filepath) {
        let mimeTypes = {
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
            p7m: 'application/x-pkcs7-mim',
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

        let ext = path.extname(filepath).slice(1)
        if (ext in mimeTypes) return mimeTypes[ext]
        return defaultMimeType
    }

    function pushField(fieldName, fieldData) {
        return new Promise((resolve, reject) => {
            dataStream.push(Buffer.from(boundary, 'utf8'))

            if (fieldData.readable) {
                let mimeType = defaultMimeType
                let filename = 'filename'

                if (fieldData.path) {
                    mimeType = getFileMimeType(fieldData.path)
                    filename = path.basename(fieldData.path)
                }

                dataStream.push(Buffer.from(`\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"`, 'utf8'))
                dataStream.push(Buffer.from(`\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'))

                fieldData.on('error', reject)
                fieldData.pipe(dataStream, { end: false })
                fieldData.on('end', () => {
                    dataStream.push(Buffer.from(`\r\n`))
                    resolve()
                })
            } else {
                dataStream.push(Buffer.from(`\r\nContent-Disposition: form-data; name="${fieldName}"`, 'utf8'))
                dataStream.push(Buffer.from(`\r\n\r\n${fieldData.toString()}\r\n`, 'utf8'))
                resolve()
            }
        })
    }

    dataStream._read = () => {
        if (reading === false) {
            reading = true
            ;(async () => {
                for (let fieldName in fields) {
                    await pushField(fieldName, fields[fieldName])
                }
                dataStream.push(Buffer.from(boundary + '--', 'utf8'))
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
