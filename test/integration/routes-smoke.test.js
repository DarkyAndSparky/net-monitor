'use strict';
/**
 * test/integration/routes-smoke.test.js
 *
 * Исторический баг: /api/categories и /api/sites были недостижимы (404),
 * потому что их роуты жили в devices.js, монтируемом на /api/devices, а
 * не на /api (см. РЕГРЕССИЯ-тесты в api.test.js). Тот баг нашёлся вручную —
 * ни один тест на тот момент не проверял сам факт «роут вообще отвечает».
 *
 * Этот файл — не замена функциональным тестам, а дешёвая страховка: бьёт
 * по каждому зарегистрированному GET-роуту проекта (кроме SSE-стримов,
 * которые не завершаются) под авторизованной admin-сессией и проверяет,
 * что ответ НЕ 404 (не потерялся при монтировании) и НЕ 500 (не упал
 * молча). Если кто-то в будущем передвинет роут на другой префикс или
 * забудет примонтировать router — этот тест укажет на конкретный путь,
 * а не только провалит какой-то один непрямой функциональный тест.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 19600 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `netmonitor-smoketest-${process.pid}-${Date.now()}.db`);

let serverProcess;
let sessionCookie = '';

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status) return true;
    } catch { /* сервер ещё не поднялся */ }
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

// Каждый зарегистрированный в server.js GET-роутер без параметров пути
// (:id-параметрические и SSE/стрим-роуты — вне охвата этого smoke-теста,
// у них своя семантика и их 404/200 не так однозначны).
const GET_ROUTES = [
  '/api/categories', '/api/sites', '/api/branding', '/api/branding/logo',
  '/api/backup', '/api/ldap',
  '/api/status', '/api/uptime', '/api/alert-settings', '/api/event-webhook',
  '/api/dashboard/widgets', '/api/features', '/api/incidents', '/api/incidents/stats',
  '/api/audit-log', '/api/audit-log/actions', '/api/audit-log/users', '/api/audit-log/export.csv',
  '/api/oui/status', '/api/mikrotik/routers', '/api/unifi/controllers', '/api/cisco/devices',
  '/api/discovery/local-subnets', '/api/discovery/lldp-cdp/devices', '/api/discovery/topology', '/api/discovery/subnet-rules',
  '/api/maintenance', '/api/maintenance/active',
  '/api/traffic/current',
  '/api/devices', '/api/devices/export.csv', '/api/devices/uptime.csv',
  '/api/logs/files', '/api/logs',
];

describe('Smoke: все зарегистрированные GET-роуты отвечают (не 404, не 500)', () => {
  before(async () => {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: { ...process.env, NETMONITOR_DB_PATH: tmpDb, HTTP_REDIRECT_PORT: String(PORT), NO_BROWSER: '1', PORT: '0', RATE_LIMIT_DISABLED: 'true' },
      stdio: 'pipe'
    });
    await waitForServer();
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'SmokeTestPass123456' }) });
  });

  after(async () => {
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
  });

  for (const route of GET_ROUTES) {
    test(`GET ${route} — не 404 и не 500`, async () => {
      const res = await api(route);
      assert.notEqual(res.status, 404, `${route} вернул 404 — роут не примонтирован туда, где его ждут (проверь app.use() в server.js)`);
      assert.ok(res.status < 500, `${route} вернул ${res.status} — роут упал молча`);
    });
  }

  test('несуществующий /api/-путь всё ещё честно отвечает 404 JSON (catch-all не сломан)', async () => {
    const res = await api('/api/this-route-does-not-exist-anywhere');
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error, 'not_found');
  });
});
