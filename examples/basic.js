// examples/basic.js
import Request from '../src/index.js'

// GET request
Request('https://httpbin.org/get')
    .then((res) => {
        const body = JSON.parse(res.buffer.toString())
        console.log('GET status:', res.statusCode)
        console.log('GET body:', body.url)
    })
    .catch(console.error)
