'use strict';
/**
 * test/unit/sse.test.js
 *
 * src/routes/sse.js — Server-Sent Events. Тестируем напрямую (не через
 * спавненный сервер): монтируем роутер в мини-express с фейковой сессией,
 * подключаемся потоковым fetch и читаем event-stream по мере поступления,
 * дёргаем экспортированные broadcast()/clientCount() из того же процесса.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const sseRouter = require('../../src/routes/sse');

let server, BASE;

describe('sse.js (unit, прямое подключение к event-stream)', () => {
  before(async () => {
    const app = express();
    app.use((req, res, next) => { req.session = { userId: 'admin' }; next(); }); // фейковая сессия
    app.use('/api', sseRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    BASE = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => { server?.close(); });

  test('без сессии — 401 (requireAuth)', async () => {
    const bareApp = express();
    bareApp.use('/api', sseRouter);
    const bareServer = await new Promise(resolve => { const s = bareApp.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const port = bareServer.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/events`);
      assert.equal(res.status, 401);
    } finally {
      bareServer.close();
    }
  });

  test('подключение отдаёт правильные SSE-заголовки и snapshot-событие сразу', async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');

    const reader = res.body.getReader();
    const { value } = await reader.read();
    const chunk = Buffer.from(value).toString('utf8');
    assert.match(chunk, /^event: snapshot\ndata: /, 'первым событием после подключения должен идти snapshot');
    assert.doesNotThrow(() => JSON.parse(chunk.split('data: ')[1].trim()), 'data snapshot-события должна быть валидным JSON');

    controller.abort();
    await new Promise(r => setTimeout(r, 100)); // даём серверу зарегистрировать close перед следующим тестом
  });

  test('clientCount() растёт при подключении и падает после закрытия соединения', async () => {
    const countBefore = sseRouter.clientCount();
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read(); // дожидаемся snapshot, чтобы соединение точно зарегистрировалось на сервере

    assert.equal(sseRouter.clientCount(), countBefore + 1);

    controller.abort();
    // req.on('close') срабатывает асинхронно — даём событийному циклу такт
    await new Promise(r => setTimeout(r, 100));
    assert.equal(sseRouter.clientCount(), countBefore, 'после разрыва соединения клиент должен быть удалён из активных');
  });

  test('broadcast() доставляет событие всем подключённым клиентам', async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read(); // snapshot

    sseRouter.broadcast('status', { id: 'd-test', online: false, lastChecked: 123456 });

    const { value } = await reader.read();
    const chunk = Buffer.from(value).toString('utf8');
    assert.match(chunk, /^event: status\ndata: /);
    const data = JSON.parse(chunk.split('data: ')[1].trim());
    assert.equal(data.id, 'd-test');
    assert.equal(data.online, false);

    controller.abort();
  });

  test('broadcast() не падает, если клиентов нет вообще', () => {
    assert.doesNotThrow(() => sseRouter.broadcast('status', { id: 'nobody-listening' }));
  });

  test('broadcast() продолжает рассылку остальным, даже если у одного клиента res.write() бросает исключение', async () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const res1 = await fetch(`${BASE}/api/events`, { signal: controller1.signal });
    const res2 = await fetch(`${BASE}/api/events`, { signal: controller2.signal });
    const reader1 = res1.body.getReader();
    const reader2 = res2.body.getReader();
    await reader1.read(); // snapshot
    await reader2.read(); // snapshot

    // Обрываем клиент 1 резко, не дожидаясь события 'close' на сервере — эмулируем
    // гонку, когда broadcast() успевает выполниться до того, как сервер узнал о разрыве.
    controller1.abort();
    sseRouter.broadcast('status', { id: 'race-test' });

    const { value } = await reader2.read();
    const chunk = Buffer.from(value).toString('utf8');
    assert.match(chunk, /race-test/, 'второй клиент должен получить событие, даже если запись первому вызвала ошибку');

    controller2.abort();
  });
});
