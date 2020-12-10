# Request - Very light HTTP client

## Installing

```shell
npm install imagickey/request
```

## How to use

```js
const request = require('request');

request('http://www.google.com')
    .then(res => {
        console.log('statusCode:', res.statusCode)  // Request status code
        console.log('body:', res.body)  // Received data
    })
    .catch(err => {
        console.log('err', err) // Request error
        console.log('body:', err.body)  // Received data (for example in 404 or 502 status code)
    })
;
```