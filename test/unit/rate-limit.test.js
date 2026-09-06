'use strict';
/**
 * test/unit/rate-limit.test.js
 *
 * src/middleware/rate-limit.js экспортирует 4 готовых лимитера
 * (apiReadLimiter/apiWriteLimiter/scanLimiter/agentLimiter) — раньше ни
 * один не был покрыт тестом. Тестируем каждый на отдельном лёгком
 * express-приложении (не поднимаем весь server.js — быстрее и не тянет
 * за собой БД/сессии), отправляя запросы напрямую через http на
 * эфемерный порт.
 *
 * Лимит по количеству запросов срабатывает независимо от того, сколько
 * реального времени прошло внутри windowMs — поэтому max+1 запросов
 * подряд достаточно, чтобы поймать 429, не дожидаясь окончания окна.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// RATE_LIMIT_DISABLED не должен быть выставлен окружением тестраннера —
// иначе весь модуль превращается в passthrough и тестировать нечего.
delete process.env.RATE_LIMIT_DISABLED;
// require свежей копии модуля (на случай, если что-то раньше в этом же
// процессе уже потребовало его с другим значением RATE_LIMIT_DISABLED)
delete require.cache[require.resolve('../../src/middleware/rate-limit')];
const { apiReadLimiter, apiWriteLimiter, scanLimiter, agentLimiter } = require('../../src/middleware/rate-limit');

const express = require('express');
const http = require('node:http');

function makeApp(limiter) {
  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true })); // должен пропускаться мимо лимитера
  app.get('/events', (req, res) => res.json({ ok: true }));  // SSE-путь, тоже должен пропускаться
  app.use(limiter);
  app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/events', (req, res) => res.status(200).json({ ok: true }));
  app.all('/', (req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(server, pathname = '/', opts = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, opts);
  return res;
}

describe('rate-limit middleware (4 профиля)', () => {
  test('apiReadLimiter: max=300 — первые 300 запросов проходят, 301-й получает 429', async () => {
    const server = await startServer(makeApp(apiReadLimiter));
    try {
      let last;
      for (let i = 0; i < 301; i++) {
        last = await request(server);
      }
      assert.equal(last.status, 429);
      const body = await last.json();
      assert.equal(body.error, 'rate_limited');
    } finally {
      server.close();
    }
  });

  test('apiWriteLimiter: max=60 — 61-й запрос блокируется, сообщение про изменение данных', async () => {
    const server = await startServer(makeApp(apiWriteLimiter));
    try {
      let last;
      for (let i = 0; i < 61; i++) {
        last = await request(server, '/', { method: 'POST' });
      }
      assert.equal(last.status, 429);
      const body = await last.json();
      assert.equal(body.error, 'rate_limited');
      assert.match(body.message, /изменение данных/);
    } finally {
      server.close();
    }
  });

  test('scanLimiter: max=10 — 11-й запрос блокируется, сообщение про сканирование/импорт', async () => {
    const server = await startServer(makeApp(scanLimiter));
    try {
      let last;
      for (let i = 0; i < 11; i++) {
        last = await request(server, '/', { method: 'POST' });
      }
      assert.equal(last.status, 429);
      const body = await last.json();
      assert.match(body.message, /сканирование/);
    } finally {
      server.close();
    }
  });

  test('apiReadLimiter: /api/health и /api/events пропускаются мимо лимита (skip)', async () => {
    const server = await startServer(makeApp(apiReadLimiter));
    try {
      // Исчерпываем весь лимит обычных запросов
      for (let i = 0; i < 300; i++) await request(server);
      const blocked = await request(server);
      assert.equal(blocked.status, 429, 'обычный путь должен быть заблокирован после исчерпания лимита');

      // health и events не должны блокироваться, даже когда лимит на / исчерпан
      const health = await request(server, '/api/health');
      const events = await request(server, '/api/events');
      assert.equal(health.status, 200, '/api/health должен пропускаться мимо rate limit');
      assert.equal(events.status, 200, '/api/events (SSE) должен пропускаться мимо rate limit');
    } finally {
      server.close();
    }
  });

  test('apiReadLimiter: устанавливает стандартные RateLimit-* заголовки', async () => {
    const server = await startServer(makeApp(apiReadLimiter));
    try {
      const res = await request(server);
      assert.ok(res.headers.get('ratelimit-limit'), 'должен быть заголовок RateLimit-Limit');
      assert.ok(res.headers.get('ratelimit-remaining') !== null, 'должен быть заголовок RateLimit-Remaining');
      assert.equal(res.headers.get('x-ratelimit-limit'), null, 'legacy-заголовки должны быть выключены');
    } finally {
      server.close();
    }
  });

  test('agentLimiter: ключ — токен из Authorization, а не IP', async () => {
    const server = await startServer(makeApp(agentLimiter));
    try {
      // 20 запросов под токеном A исчерпывают лимит токена A...
      let last;
      for (let i = 0; i < 21; i++) {
        last = await request(server, '/', { headers: { Authorization: 'Bearer token-A' } });
      }
      assert.equal(last.status, 429, 'токен A должен быть заблокирован на 21-м запросе');

      // ...но токен B с того же самого IP (тот же тестовый процесс) — не заблокирован,
      // потому что ключ лимитера — токен, а не IP
      const otherToken = await request(server, '/', { headers: { Authorization: 'Bearer token-B' } });
      assert.equal(otherToken.status, 200, 'другой токен с того же IP не должен делить лимит с token-A');
    } finally {
      server.close();
    }
  });
});

describe('rate-limit middleware — RATE_LIMIT_DISABLED=true', () => {
  let disabledLimiters;

  before(() => {
    process.env.RATE_LIMIT_DISABLED = 'true';
    delete require.cache[require.resolve('../../src/middleware/rate-limit')];
    disabledLimiters = require('../../src/middleware/rate-limit');
  });

  after(() => {
    delete process.env.RATE_LIMIT_DISABLED;
    delete require.cache[require.resolve('../../src/middleware/rate-limit')];
  });

  test('при RATE_LIMIT_DISABLED=true лимитер становится passthrough — не блокирует даже после сотен запросов', async () => {
    const server = await startServer(makeApp(disabledLimiters.apiWriteLimiter));
    try {
      let last;
      for (let i = 0; i < 200; i++) {
        last = await request(server, '/', { method: 'POST' });
      }
      assert.equal(last.status, 200, 'RATE_LIMIT_DISABLED=true должен полностью отключать лимитер');
      assert.equal(last.headers.get('ratelimit-limit'), null, 'passthrough-режим не должен добавлять RateLimit-заголовки');
    } finally {
      server.close();
    }
  });
});
