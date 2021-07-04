# Request - Very light HTTP client

## Installing

```shell
npm install imagickey/request
```

## How to use

```js
const request = require('request');

request('http://www.google.com', options = {})
    .then(res => {
        console.log('statusCode:', res.statusCode)  // Request status code
        console.log('body as buffer:', res.buffer)  // Received buffer
        console.log('body as string:', res.buffer.toString())  // Received buffer
    })
    .catch(err => {
        console.log('err', err) // Request error
        console.log('body as buffer:', err.buffer)  // Received data (for example in 404 or 502 status code)
    })
;
```

## Options
Accepts all options from [http.request()](https://nodejs.org/api/http.html#http_http_request_options_callback)

## Additional options
- `formData` - data to pass for a `multipart/form-data` request

---


## Forms

## Multipart Form Uploads (multipart/form-data)

```js
request('https://example.com/', {
    formData: {
        field: 'value',   //simple field - value 
        file: fs.createReadStream('../path/to/file'),
    }
})
```