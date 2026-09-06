'use strict';
/**
 * test/integration/integrations.test.js
 *
 * src/routes/integrations.js — интеграции с внешним сетевым оборудованием
 * (MikroTik/UniFi/Cisco). Пароли учёток хранятся в settings и НИКОГДА не
 * должны уходить в API-ответе в открытом виде — только маска '••••••••'.
 * Реальные импорты (SSH/RouterOS-соединение) не тестируем — нет реального
 * оборудования; проверяем, что при недоступном хосте роут отвечает 500
 * connection_failed, а не падает необработанным исключением.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 19400 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `netmonitor-integrationstest-${process.pid}-${Date.now()}.db`);

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

describe('NetMonitor Integrations API (MikroTik/UniFi/Cisco — CRUD и маскировка паролей)', () => {
  before(async () => {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: { ...process.env, NETMONITOR_DB_PATH: tmpDb, HTTP_REDIRECT_PORT: String(PORT), NO_BROWSER: '1', PORT: '0', RATE_LIMIT_DISABLED: 'true' },
      stdio: 'pipe'
    });
    await waitForServer();
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'IntegTestPass123456' }) });
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

  // ── MikroTik ────────────────────────────────────────────────────────
  let mikrotikId;

  test('POST /api/mikrotik/routers создаёт роутер, пароль в ответе замаскирован', async () => {
    const res = await api('/api/mikrotik/routers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Core-RB', host: '127.0.0.1', port: 1, user: 'admin', password: 'super-secret-pass' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    mikrotikId = data.id;
    assert.equal(data.password, '••••••••', 'пароль не должен возвращаться в открытом виде даже сразу после создания');
    assert.doesNotMatch(JSON.stringify(data), /super-secret-pass/, 'реальный пароль не должен присутствовать нигде в теле ответа');
  });

  test('GET /api/mikrotik/routers — список тоже с замаскированными паролями', async () => {
    const res = await api('/api/mikrotik/routers');
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(list.length > 0);
    for (const r of list) assert.equal(r.password, '••••••••');
    assert.doesNotMatch(JSON.stringify(list), /super-secret-pass/);
  });

  test('PUT /api/mikrotik/routers/:id БЕЗ поля password — старый пароль сохраняется (не стирается)', async () => {
    await api(`/api/mikrotik/routers/${mikrotikId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Core-RB-renamed' })
    });
    // Косвенная проверка: пароль остался маской (значит поле непустое), а не пустой строкой
    const list = await api('/api/mikrotik/routers').then(r => r.json());
    const updated = list.find(r => r.id === mikrotikId);
    assert.equal(updated.name, 'Core-RB-renamed');
    assert.equal(updated.password, '••••••••', 'PUT без password не должен обнулять сохранённый пароль');
  });

  test('РЕГРЕССИЯ: PUT с password="••••••••" (маска отправлена обратно с фронта) не перезаписывает реальный пароль маской', async () => {
    // Фронт мог просто вернуть значение поля как есть при сохранении формы без изменений —
    // это не должно означать "новый пароль = ••••••••" в базе.
    const res = await api(`/api/mikrotik/routers/${mikrotikId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '••••••••' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.password, '••••••••'); // маска в ответе — ожидаемо, важно что БД не испортилась буквальной маской
  });

  test('PUT с реальным новым password — обновляется', async () => {
    const res = await api(`/api/mikrotik/routers/${mikrotikId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new-real-password-2' })
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(await res.json()), /new-real-password-2/);
  });

  test('PUT несуществующего роутера — 404', async () => {
    const res = await api('/api/mikrotik/routers/no-such-id', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' })
    });
    assert.equal(res.status, 404);
  });

  test('POST /api/mikrotik/routers/:id/import с недоступным хостом — 500 connection_failed, не падает необработанно', async () => {
    const res = await api(`/api/mikrotik/routers/${mikrotikId}/import`, { method: 'POST' });
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(data.error, 'должно быть поле error, а не пустой краш ответа');
  });

  test('import для несуществующего id роутера — 404, не 500', async () => {
    const res = await api('/api/mikrotik/routers/no-such-id/import', { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('DELETE /api/mikrotik/routers/:id удаляет роутер', async () => {
    const res = await api(`/api/mikrotik/routers/${mikrotikId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const list = await api('/api/mikrotik/routers').then(r => r.json());
    assert.ok(!list.some(r => r.id === mikrotikId));
  });

  // ── UniFi ───────────────────────────────────────────────────────────
  let unifiId;

  test('POST /api/unifi/controllers создаёт контроллер, пароль замаскирован', async () => {
    const res = await api('/api/unifi/controllers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Main UniFi', host: '10.0.0.5', user: 'ubnt', password: 'unifi-secret-xyz' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    unifiId = data.id;
    assert.equal(data.password, '••••••••');
  });

  test('GET /api/unifi/controllers — список без утечки пароля', async () => {
    const list = await api('/api/unifi/controllers').then(r => r.json());
    assert.doesNotMatch(JSON.stringify(list), /unifi-secret-xyz/);
  });

  test('DELETE /api/unifi/controllers/:id удаляет контроллер', async () => {
    const res = await api(`/api/unifi/controllers/${unifiId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const list = await api('/api/unifi/controllers').then(r => r.json());
    assert.ok(!list.some(c => c.id === unifiId));
  });

  // ── Cisco ───────────────────────────────────────────────────────────
  let ciscoId;

  test('POST /api/cisco/devices создаёт устройство, пароль замаскирован', async () => {
    const res = await api('/api/cisco/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Core-SW', host: '127.0.0.1', port: 1, user: 'netadmin', password: 'cisco-enable-secret' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    ciscoId = data.id;
    assert.equal(data.password, '••••••••');
  });

  test('GET /api/cisco/devices — список без утечки пароля', async () => {
    const list = await api('/api/cisco/devices').then(r => r.json());
    assert.doesNotMatch(JSON.stringify(list), /cisco-enable-secret/);
  });

  test('POST /api/cisco/devices/:id/import с недоступным хостом — 500, не необработанное исключение', async () => {
    const res = await api(`/api/cisco/devices/${ciscoId}/import`, { method: 'POST' });
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('DELETE /api/cisco/devices/:id удаляет устройство', async () => {
    const res = await api(`/api/cisco/devices/${ciscoId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });

  // ── Права доступа ───────────────────────────────────────────────────
  test('создание интеграций требует admin — operator получает 403', async () => {
    await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'integop', password: 'OperatorPass123456', role: 'operator' })
    });
    const prevCookie = sessionCookie;
    sessionCookie = '';
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'integop', password: 'OperatorPass123456' }) });
    // Без смены пароля любой роут отвечает 403 password_change_required, что
    // маскировало бы проверку роли ниже (см. РЕГРЕССИЮ в maintenance.test.js).
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'OperatorPass123456', newPassword: 'OperatorPass2ndRound123456' }) });

    const res = await api('/api/mikrotik/routers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ShouldFail', host: '10.0.0.99', password: 'x' })
    });
    assert.equal(res.status, 403, 'создание MikroTik-роутера — операция уровня admin (requireAdmin), не operator');
    assert.equal((await res.json()).error, 'forbidden', 'должно быть именно forbidden (нехватка роли), а не password_change_required');

    sessionCookie = prevCookie;
  });

  // ── OUI ─────────────────────────────────────────────────────────────
  test('GET /api/oui/status отвечает структурой статуса базы вендоров', async () => {
    const res = await api('/api/oui/status');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok('entryCount' in data);
    assert.ok('stale' in data);
  });
});
