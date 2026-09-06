'use strict';
/**
 * test/integration/maintenance.test.js
 *
 * src/routes/maintenance.js — окна обслуживания (мониторинг идёт, алерты
 * не шлются). Раньше 46% (только случайное покрытие от общих тестов),
 * без выделенных тестов на валидацию и /active-логику.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 19300 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `netmonitor-maintenancetest-${process.pid}-${Date.now()}.db`);

let serverProcess;
let sessionCookie = '';
let deviceId;

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

describe('NetMonitor Maintenance API (окна обслуживания)', () => {
  before(async () => {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: { ...process.env, NETMONITOR_DB_PATH: tmpDb, HTTP_REDIRECT_PORT: String(PORT), NO_BROWSER: '1', PORT: '0', RATE_LIMIT_DISABLED: 'true' },
      stdio: 'pipe'
    });
    await waitForServer();
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'MaintTestPass123456' }) });
    const dev = await api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MaintTestDevice', ip: '10.0.0.150' })
    }).then(r => r.json());
    deviceId = dev.id;
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

  test('GET /api/maintenance изначально пустой список', async () => {
    const res = await api('/api/maintenance');
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.deepEqual(list, []);
  });

  test('POST без startTs/endTs — 400 start_end_required', async () => {
    const res = await api('/api/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'start_end_required');
  });

  test('POST с endTs <= startTs — 400 invalid_range', async () => {
    const now = Date.now();
    const res = await api('/api/maintenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTs: now + 10000, endTs: now, allDevices: true })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'invalid_range');
  });

  test('РЕГРЕССИЯ: окно длиннее 30 дней — 400 too_long', async () => {
    const now = Date.now();
    const res = await api('/api/maintenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTs: now, endTs: now + 31 * 24 * 60 * 60 * 1000, allDevices: true })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'too_long');
  });

  test('POST без allDevices и без deviceIds — 400 devices_required', async () => {
    const now = Date.now();
    const res = await api('/api/maintenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTs: now, endTs: now + 3600000, allDevices: false, deviceIds: [] })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'devices_required');
  });

  let activeWindowId;
  test('POST валидное окно (сейчас активно, конкретное устройство) — создаётся, active=true', async () => {
    const now = Date.now();
    const res = await api('/api/maintenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Плановая перезагрузка', startTs: now - 60000, endTs: now + 3600000, deviceIds: [deviceId], note: 'test note' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    activeWindowId = data.id;
    assert.equal(data.active, true, 'окно, чей интервал включает "сейчас", должно быть active=true');
    assert.deepEqual(data.deviceIds, [deviceId]);
    assert.equal(data.allDevices, false);
    assert.equal(data.note, 'test note');
  });

  test('окно в будущем (ещё не началось) — active=false', async () => {
    const now = Date.now();
    const res = await api('/api/maintenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Будущее окно', startTs: now + 3600000, endTs: now + 7200000, allDevices: true })
    });
    const data = await res.json();
    assert.equal(data.active, false, 'окно в будущем не должно быть активным прямо сейчас');
  });

  test('GET /api/maintenance/active возвращает только активное окно, не будущее', async () => {
    const res = await api('/api/maintenance/active');
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(list.every(w => w.active), 'все окна в /active должны быть active=true');
    assert.ok(list.some(w => w.id === activeWindowId));
  });

  test('GET /api/maintenance возвращает оба окна, отсортированные по start_ts DESC', async () => {
    const res = await api('/api/maintenance');
    const list = await res.json();
    assert.equal(list.length, 2);
    assert.ok(list[0].startTs >= list[1].startTs, 'должны быть отсортированы по убыванию startTs');
  });

  test('DELETE несуществующего окна — 404', async () => {
    const res = await api('/api/maintenance/no-such-id', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('DELETE удаляет окно', async () => {
    const res = await api(`/api/maintenance/${activeWindowId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const list = await api('/api/maintenance').then(r => r.json());
    assert.ok(!list.some(w => w.id === activeWindowId));
  });

  test('создание/удаление окна требует operator — viewer получает 403; чтение доступно viewer', async () => {
    await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'maintviewer', password: 'ViewerPass123456', role: 'viewer' })
    });
    const prevCookie = sessionCookie;
    sessionCookie = '';
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'maintviewer', password: 'ViewerPass123456' }) });
    // Новый пользователь получает mustChangePassword=true — до смены пароля ЛЮБОЙ
    // роут (кроме /api/me, /api/change-password, /api/logout) отвечает 403
    // password_change_required, что маскирует проверку роли ниже.
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'ViewerPass123456', newPassword: 'ViewerPass2ndRound123456' }) });

    const now = Date.now();
    const res = await api('/api/maintenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTs: now, endTs: now + 3600000, allDevices: true })
    });
    assert.equal(res.status, 403, 'POST должен быть запрещён именно ролью (requireOperator)');

    // Но читать список viewer может (requireAuth, не requireOperator)
    const readRes = await api('/api/maintenance');
    assert.equal(readRes.status, 200);

    sessionCookie = prevCookie;
  });
});
