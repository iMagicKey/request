# UPDATE — imagic-request

> Аудит проведён: 2026-03-22. Версия на момент аудита: 1.0.1

---

## Критические баги (исправить немедленно)

- [ ] **`async` executor в Promise** — `new Promise(async (resolve, reject) => { ... })` — anti-pattern. Если async-код внутри бросает ошибку до первого `await`, Promise не реджектится (ошибка уходит в unhandledRejection). Нужно рефакторить на `async function` + `try/catch` без обёртки в `new Promise`.

- [ ] **Binary data corruption** — `Buffer.from(data, 'binary')` в data-обработчике интерпретирует каждый byte через latin-1, что портит бинарные данные (изображения, сжатые ответы). Правильно: `Buffer.isBuffer(data) ? data : Buffer.from(data)`.

- [ ] **`multipartform.js` — сломан `this` в strict ESM (КРИТИЧНО)** — функция `createMultipartForm` использует `this.stream`, `this.fields`, `this.files` и т.д., но вызывается как обычная функция `createMultipartForm(...)`, а не через `new`. В strict mode ES Modules `this` будет `undefined`, что ломает **все** multipart/file upload запросы. Нужно рефакторить: либо в class, либо в функцию с локальными переменными.

- [ ] **`dns` опция задокументирована, но не реализована** — README описывает `{ dns: '8.8.8.8' }`, но в коде этот параметр игнорируется. Либо реализовать, либо убрать из документации.

---

## package.json

- [ ] Добавить `"exports"`:
  ```json
  "exports": { ".": "./src/index.js", "./package.json": "./package.json" }
  ```
- [ ] Добавить `"files": ["src", "README.md", "LICENSE"]`
- [ ] Добавить `"sideEffects": false`
- [ ] Добавить `devDependencies` — сейчас их нет совсем:
  ```json
  "@eslint/js": "^10.0.1",
  "chai": "^5.x",
  "eslint": "^10.1.0",
  "eslint-config-prettier": "^10.1.8",
  "eslint-plugin-import": "^2.32.0",
  "eslint-plugin-n": "^17.24.0",
  "eslint-plugin-prettier": "^5.5.5",
  "eslint-plugin-promise": "^7.2.1",
  "globals": "^16.x",
  "prettier": "^3.8.1"
  ```
- [ ] Добавить `"scripts.lint"` и `"scripts.lint:fix"`
- [ ] Обновить `"scripts.test"`: `"node --test ./tests/**/*.test.js"`

---

## ESLint

- [ ] Создать `eslint.config.js` по стандарту (файл отсутствует)
- [ ] Создать `.prettierrc.json`

---

## Тесты

Тестов нет. Написать `tests/request.test.js`:

- [ ] GET запрос возвращает `statusCode`, `headers`, `buffer`
- [ ] HTTPS запрос корректно резолвится
- [ ] Timeout опция вызывает reject с timeout-ошибкой
- [ ] Multipart/formdata устанавливает корректный `Content-Type` с boundary — **тест найдёт текущий баг**
- [ ] Бинарные данные не повреждаются (проверка integrity буфера с известными байтами)
- [ ] Невалидный URL (не строка) бросает синхронно
- [ ] Сетевая ошибка вызывает reject
- [ ] Gzip/brotli/deflate декомпрессия возвращает корректный результат
- [ ] Тело запроса типа object (не строка/Buffer) — должно бросать ошибку

---

## Улучшения API (minor bump)

- [ ] **Default timeout** — добавить `options.timeout` по умолчанию (например, 30000мс), чтобы избежать висящих запросов в production
- [ ] **`maxBodySize` опция** — ограничение размера ответа для предотвращения OOM при злонамеренных серверах
- [ ] **`retry` опция** — `{ retry: 3, retryDelay: 1000 }` для автоматических повторов при сетевых ошибках
- [ ] **Wrapper return объект** — вместо мутации сырого `res` возвращать `{ statusCode, headers, buffer, body }`. Сейчас `res.buffer` добавляется к объекту Node.js response, что является side-effect
- [ ] **Валидация тела запроса** — если `body` это object, сейчас молча отправляется `[object Object]`. Нужно бросать ошибку или автоматически делать `JSON.stringify`
- [ ] **Реализовать `dns` опцию** — использовать `dns.lookup` / `dns.resolve` с кастомным сервером

---

## Задачи (backlog)

- [ ] Поддержка `AbortController` / `AbortSignal` для отмены запросов
- [ ] Поддержка redirect следования (сейчас отсутствует)
- [ ] Экспорт TypeScript-типов
- [ ] Поддержка streamed ответов (без буферизации в памяти)
