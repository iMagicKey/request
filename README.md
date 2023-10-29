# Request - Very light HTTP client

## Installing

```shell
npm install imagic-request
```

## How to use

```js
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