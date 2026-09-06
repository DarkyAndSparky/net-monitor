'use strict';
/**
 * test/integration/agent.test.js
 *
 * src/routes/agent.js — единственный публичный (без сессии) роут в проекте:
 * POST /api/agent/report авторизуется токеном устройства в заголовке
 * Authorization, а не cookie-сессией. Раньше 0% покрытия.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 19700 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `netmonitor-agenttest-${process.pid}-${Date.now()}.db`);

let serverProcess;
let sessionCookie = '';
let deviceId;

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

describe('NetMonitor Agent API (токен-аутентификация метрик агента)', () => {
  before(async () => {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: { ...process.env, NETMONITOR_DB_PATH: tmpDb, HTTP_REDIRECT_PORT: String(PORT), NO_BROWSER: '1', PORT: '0', RATE_LIMIT_DISABLED: 'true' },
      stdio: 'pipe'
    });
    await waitForServer();
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'AgentTestPass123456' }) });

    const created = await api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AgentTestDevice', ip: '10.0.0.222', monitored: false })
    }).then(r => r.json());
    deviceId = created.id;
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

  test('POST /api/agent/report без заголовка Authorization — 401 missing_token', async () => {
    const res = await api('/api/agent/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cpu_pct: 50 }) });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'missing_token');
  });

  test('POST /api/agent/report с несуществующим токеном — 401 invalid_token', async () => {
    const res = await api('/api/agent/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({ cpu_pct: 50 })
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'invalid_token');
  });

  test('GET /api/devices/:id/agent/token генерирует токен при первом обращении', async () => {
    const res = await api(`/api/devices/${deviceId}/agent/token`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.token && data.token.length >= 32, 'токен должен быть сгенерирован и достаточно длинным');
  });

  test('повторный GET того же токена возвращает ТОТ ЖЕ токен (не перегенерирует молча)', async () => {
    const first = await api(`/api/devices/${deviceId}/agent/token`).then(r => r.json());
    const second = await api(`/api/devices/${deviceId}/agent/token`).then(r => r.json());
    assert.equal(first.token, second.token, 'GET не должен быть побочно-эффектным — токен не должен меняться при простом чтении');
  });

  test('POST /api/agent/report с валидным токеном принимает метрики', async () => {
    const { token } = await api(`/api/devices/${deviceId}/agent/token`).then(r => r.json());
    const res = await api('/api/agent/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cpu_pct: 42.5, ram_pct: 60, ram_used_mb: 6000, ram_total_mb: 10000, hostname: 'test-host', os: 'Linux' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });

  test('метрики после report видны в /api/devices/:id/agent/metrics', async () => {
    const res = await api(`/api/devices/${deviceId}/agent/metrics`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.linked, true);
    assert.ok(data.latest, 'должен быть latest-снапшот после отправленного report');
    assert.equal(data.latest.cpuPct, 42.5);
    assert.equal(data.latest.hostname, 'test-host');
  });

  test('РЕГРЕССИЯ: POST /api/agent/report с нечисловыми полями метрик не падает 500, пишет null', async () => {
    const { token } = await api(`/api/devices/${deviceId}/agent/token`).then(r => r.json());
    const res = await api('/api/agent/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cpu_pct: 'not-a-number', ram_pct: null, hostname: 123 })
    });
    assert.equal(res.status, 200, 'мусорные значения в отчёте не должны валить обработчик 500-й ошибкой');
  });

  test('POST /api/devices/:id/agent/reset выпускает НОВЫЙ токен, старый перестаёт работать', async () => {
    const oldTokenRes = await api(`/api/devices/${deviceId}/agent/token`).then(r => r.json());
    const resetRes = await api(`/api/devices/${deviceId}/agent/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 200);
    const { token: newToken } = await resetRes.json();
    assert.notEqual(newToken, oldTokenRes.token, 'reset должен выдать новый токен, отличный от старого');

    // Старый токен больше не должен приниматься
    const withOldToken = await api('/api/agent/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oldTokenRes.token}` },
      body: JSON.stringify({ cpu_pct: 1 })
    });
    assert.equal(withOldToken.status, 401, 'старый токен должен быть отозван после reset');

    // Новый — должен
    const withNewToken = await api('/api/agent/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newToken}` },
      body: JSON.stringify({ cpu_pct: 1 })
    });
    assert.equal(withNewToken.status, 200);
  });

  test('DELETE /api/devices/:id/agent отвязывает агента — токен перестаёт работать, metrics.linked=false', async () => {
    const { token } = await api(`/api/devices/${deviceId}/agent/token`).then(r => r.json());
    const delRes = await api(`/api/devices/${deviceId}/agent`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);

    const withUnlinkedToken = await api('/api/agent/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cpu_pct: 1 })
    });
    assert.equal(withUnlinkedToken.status, 401, 'токен отвязанного агента не должен приниматься');

    const metrics = await api(`/api/devices/${deviceId}/agent/metrics`).then(r => r.json());
    assert.equal(metrics.linked, false);
  });

  test('токен/reset/unlink недоступны без прав operator (viewer получает 403)', async () => {
    await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'agentviewer', password: 'ViewerPass123456', role: 'viewer' })
    });
    const prevCookie = sessionCookie;
    sessionCookie = '';
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'agentviewer', password: 'ViewerPass123456' }) });
    // Без смены пароля любой роут отвечает 403 password_change_required, что
    // маскировало бы проверку роли ниже (см. РЕГРЕССИЮ в maintenance.test.js).
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'ViewerPass123456', newPassword: 'ViewerPass2ndRound123456' }) });

    const tokenRes = await api(`/api/devices/${deviceId}/agent/token`);
    assert.equal(tokenRes.status, 403);
    assert.equal((await tokenRes.json()).error, 'forbidden', 'должно быть именно forbidden (нехватка роли), а не password_change_required');
    const resetRes = await api(`/api/devices/${deviceId}/agent/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 403);

    sessionCookie = prevCookie;
  });

  test('операции над несуществующим устройством отвечают 404', async () => {
    const noSuchId = 999999;
    const tokenRes = await api(`/api/devices/${noSuchId}/agent/token`);
    assert.equal(tokenRes.status, 404);
    const resetRes = await api(`/api/devices/${noSuchId}/agent/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 404);
    const metricsRes = await api(`/api/devices/${noSuchId}/agent/metrics`);
    assert.equal(metricsRes.status, 404);
  });
});
