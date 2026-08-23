'use strict';
/**
 * test/unit/event-webhook.test.js
 *
 * Изолирован в отдельном файле специально: node:test запускает каждый
 * .test.js файл в отдельном процессе, поэтому здесь можно безопасно задать
 * свой NETMONITOR_DB_PATH и замокать global.fetch, не задевая другие тесты.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `netmonitor-test-ew-${process.pid}-${Date.now()}.db`);
process.env.NETMONITOR_DB_PATH = tmpDb;

const { setSetting } = require('../../src/db');
const { fireEvent } = require('../../src/services/eventWebhook');

describe('eventWebhook.fireEvent (webhook на любое событие)', () => {
  let capturedRequests;
  const realFetch = global.fetch;

  function mockFetch() {
    capturedRequests = [];
    global.fetch = async (url, opts) => {
      capturedRequests.push({ url, opts });
      return { ok: true };
    };
  }
  function restoreFetch() { global.fetch = realFetch; }

  test('отправляет запрос, если webhook включён и событие не отфильтровано', async () => {
    mockFetch();
    setSetting('eventWebhook', { enabled: true, url: 'https://example.com/hook', events: [], secret: 'topsecret' });
    await fireEvent('device.create', 'Added Router1', { username: 'admin', ip: '127.0.0.1' });
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0].url, 'https://example.com/hook');
    const body = JSON.parse(capturedRequests[0].opts.body);
    assert.equal(body.event, 'device.create');
    assert.equal(body.details, 'Added Router1');
    assert.equal(body.user, 'admin');
    assert.equal(body.ip, '127.0.0.1');
    assert.ok(body.time); // ISO timestamp присутствует
    assert.equal(capturedRequests[0].opts.headers['X-Netmonitor-Secret'], 'topsecret');
    restoreFetch();
  });

  test('не отправляет запрос, если webhook выключен', async () => {
    mockFetch();
    setSetting('eventWebhook', { enabled: false, url: 'https://example.com/hook' });
    await fireEvent('device.create', 'x', {});
    assert.equal(capturedRequests.length, 0);
    restoreFetch();
  });

  test('не отправляет запрос без указанного URL, даже если enabled=true', async () => {
    mockFetch();
    setSetting('eventWebhook', { enabled: true, url: '' });
    await fireEvent('device.create', 'x', {});
    assert.equal(capturedRequests.length, 0);
    restoreFetch();
  });

  test('фильтр events[] пропускает только перечисленные типы', async () => {
    mockFetch();
    setSetting('eventWebhook', { enabled: true, url: 'https://example.com/hook', events: ['user.create'] });
    await fireEvent('device.create', 'x', {});
    assert.equal(capturedRequests.length, 0, 'device.create не в фильтре — не должно уйти');
    await fireEvent('user.create', 'x', {});
    assert.equal(capturedRequests.length, 1, 'user.create в фильтре — должно уйти');
    restoreFetch();
  });

  test('пустой events[] означает «все события» — ничего не фильтруется', async () => {
    mockFetch();
    setSetting('eventWebhook', { enabled: true, url: 'https://example.com/hook', events: [] });
    await fireEvent('any.random.action', 'x', {});
    assert.equal(capturedRequests.length, 1);
    restoreFetch();
  });

  test('без секрета заголовок X-Netmonitor-Secret не добавляется', async () => {
    mockFetch();
    setSetting('eventWebhook', { enabled: true, url: 'https://example.com/hook', events: [] });
    await fireEvent('device.create', 'x', {});
    assert.equal('X-Netmonitor-Secret' in capturedRequests[0].opts.headers, false);
    restoreFetch();
  });

  test('сбой сети (fetch бросает исключение) не пробрасывается наружу', async () => {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    setSetting('eventWebhook', { enabled: true, url: 'https://unreachable.example.com/hook', events: [] });
    await assert.doesNotReject(fireEvent('device.create', 'x', {}));
    restoreFetch();
  });
});
