import request from '../src/index.js'

request('https://www.google.com/', {
    dns: '8.8.8.8',
})
    .then((res) => {
        console.log(res.statusCode)
    })
    .catch((err) => {
        console.log(err)
    })
