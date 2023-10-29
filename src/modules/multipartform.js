import stream from 'stream'
import path from 'path'

export default function createMultipartForm(fields) {
    this.stream = new stream.Duplex()
    this.fields = fields
    this.reading = false
    this.defaultMimeType = 'application/octet-stream'

    this.boundary = '-----'
    for (let i = 0; i < 24; i++) {
        this.boundary += Math.floor(Math.random() * 10).toString(16)
    }

    this.stream._read = async () => {
        if (this.reading == false) {
            this.reading = true

            for (let fieldName in this.fields) {
                await this.pushField(fieldName, this.fields[fieldName])
            }
            this.stream.push(Buffer.from(this.boundary + '--', 'utf8'))
            this.stream.push(null)
        }

        return
    }

    this.stream._write = (chunk, encoding, callback) => {
        this.stream.push(chunk)
        callback()
    }

    this.pushField = (fieldName, fieldData) => {
        return new Promise((resolve) => {
            this.stream.push(Buffer.from(this.boundary, 'utf8'))

            if (fieldData.readable) {
                let mimeType = this.defaultMimeType
                let filename = 'filename'

                if (fieldData.path) {
                    mimeType = this.getFileMimeType(fieldData.path)
                    filename = path.basename(fieldData.path)
                }

                this.stream.push(Buffer.from(`\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"`, 'utf8'))
                this.stream.push(Buffer.from(`\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'))

                fieldData.pipe(this.stream, { end: false })
                fieldData.on('end', () => {
                    this.stream.push(Buffer.from(`\r\n`))

                    resolve()
                })
            } else {
                this.stream.push(Buffer.from(`\r\nContent-Disposition: form-data; name="${fieldName}"`, 'utf8'))
                this.stream.push(Buffer.from(`\r\n\r\n${fieldData.toString()}\r\n`, 'utf8'))

                resolve()
            }
        })
    }

    this.getFileMimeType = (filepath) => {
        let mimeTypes = {
            json: 'application/json',
            pdf: 'application/pdf',
            zip: 'application/zip',
            gzip: 'application/gzip',
            rar: 'application/x-rar-compressed',
            tar: 'application/x-tar',
            torrent: 'application/x-bittorrent',
            doc: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            docx: 'application/msword',
            xls: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            xlsx: 'application/vnd.ms-excel',
            xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
            ppt: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            pptx: 'application/vnd.ms-powerpoint',
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
        if (ext in mimeTypes) {
            return mimeTypes[ext]
        }

        return this.defaultMimeType
    }

    return {
        dataStream: this.stream,
        boundary: this.boundary.slice(2),
    }
}
