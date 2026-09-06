'use strict';
/**
 * test/integration/metrics.test.js
 *
 * src/routes/metrics.js — GET /metrics в формате Prometheus text exposition.
 * Раньше 28% (только парсинг package.json версии случайно затронут).
 * Два блока: без METRICS_TOKEN (открытый эндпоинт, дефолт) и с ним
 * (отдельный процесс сервера — токен читается из process.env при каждом
 * запросе, но переменная окружения фиксируется на старте дочернего процесса).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function makeHarness(portBase, extraEnv = {}) {
  const PORT = portBase + (process.pid % 500);
  const BASE = `http://127.0.0.1:${PORT}`;
  const tmpDb = path.join(os.tmpdir(), `netmonitor-metricstest-${portBase}-${process.pid}-${Date.now()}.db`);
  let serverProcess;
  let sessionCookie = '';

  async function waitForServer(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { const res = await fetch(`${BASE}/`); if (res.status) return true; }
      catch { /* сервер ещё не поднялся */ }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Сервер не поднялся за отведённое время');
  }

  async function api(pathname, opts = {}) {
    const headers = Object.assign({}, opts.headers, sessionCookie ? { Cookie: sessionCookie } : {});
    const res = await fetch(`${BASE}${pathname}`, { ...opts, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) sessionCookie = setCookie.split(';')[0];
    return res;
  }

  async function start() {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: { ...process.env, ...extraEnv, NETMONITOR_DB_PATH: tmpDb, HTTP_REDIRECT_PORT: String(PORT), NO_BROWSER: '1', PORT: '0', RATE_LIMIT_DISABLED: 'true' },
      stdio: 'pipe'
    });
    await waitForServer();
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'MetricsTestPass123456' }) });
  }

  async function stop() {
    if (serverProcess) {
      await new Promise((resolve) => {
        serverProcess.once('exit', resolve);
        serverProcess.kill('SIGTERM');
        setTimeout(() => { serverProcess.kill('SIGKILL'); resolve(); }, 5000).unref();
      });
    }
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
    try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  }

  return { start, stop, api };
}

describe('NetMonitor Metrics API (Prometheus, без METRICS_TOKEN)', () => {
  const h = makeHarness(19100);

  before(h.start);
  after(h.stop);

  test('GET /metrics без авторизации отвечает 200 и правильным Content-Type', async () => {
    const res = await h.api('/metrics');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain.*version=0\.0\.4/);
  });

  test('тело содержит HELP/TYPE и базовые счётчики устройств', async () => {
    const res = await h.api('/metrics');
    const text = await res.text();
    assert.match(text, /# HELP netmonitor_build_info/);
    assert.match(text, /# TYPE netmonitor_devices_total gauge/);
    assert.match(text, /netmonitor_devices_total \d+/);
    assert.match(text, /netmonitor_server_uptime_seconds/);
  });

  test('build_info содержит версию из package.json', async () => {
    const pkg = require('../../package.json');
    const res = await h.api('/metrics');
    const text = await res.text();
    assert.match(text, new RegExp(`netmonitor_build_info\\{version="${pkg.version.replace(/\./g, '\\.')}"\\} 1`));
  });

  test('после создания устройства devices_total увеличивается на 1', async () => {
    const before = await h.api('/metrics').then(r => r.text());
    const beforeTotal = Number(before.match(/netmonitor_devices_total (\d+)/)[1]);

    await h.api('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MetricsTestDevice', ip: '10.0.0.240' }) });

    const after = await h.api('/metrics').then(r => r.text());
    const afterTotal = Number(after.match(/netmonitor_devices_total (\d+)/)[1]);
    assert.equal(afterTotal, beforeTotal + 1);
  });

  test('РЕГРЕССИЯ: имя устройства с кавычками и обратным слешем не ломает Prometheus-формат (экранирование label)', async () => {
    // device_up (с меткой name) появляется только после реального тика планировщика
    // (5с, использует настоящий ICMP-пинг — в песочнице без ICMP это зависает, см.
    // discovery.test.js) — поэтому не дожидаемся его и не проверяем экранирование
    // побайтово через HTTP. Главный регрессионный сигнал — что спецсимволы в имени
    // устройства (кавычки, обратный слеш) не валят обработчик 500-й прямо на создании
    // устройства и на немедленном опросе /metrics.
    await h.api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Router "Core" \\ Backup', ip: '10.0.0.241', monitored: true })
    });
    const res = await h.api('/metrics');
    assert.equal(res.status, 200, 'спецсимволы в имени устройства не должны валить обработчик 500-й');
  });

  test('/metrics не требует сессии (публичный эндпоинт для Prometheus scrape)', async () => {
    // h.api не добавляет Cookie, если sessionCookie ещё не был установлен для этого
    // запроса — но чтобы не зависеть от порядка тестов, проверяем явно без опций.
    const res = await h.api('/metrics', { headers: {} });
    assert.equal(res.status, 200);
  });
});

describe('NetMonitor Metrics API (с METRICS_TOKEN — защищённый эндпоинт)', () => {
  const TOKEN = 'super-secret-metrics-token';
  const h = makeHarness(19110, { METRICS_TOKEN: TOKEN });

  before(h.start);
  after(h.stop);

  test('без заголовка Authorization — 401 с WWW-Authenticate', async () => {
    const res = await h.api('/metrics');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Bearer/);
  });

  test('с неверным токеном — 401', async () => {
    const res = await h.api('/metrics', { headers: { Authorization: 'Bearer wrong-token' } });
    assert.equal(res.status, 401);
  });

  test('с правильным токеном — 200 и тело метрик', async () => {
    const res = await h.api('/metrics', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /netmonitor_build_info/);
  });
});
