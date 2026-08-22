'use strict';
/**
 * test/integration/api.test.js
 *
 * Поднимает настоящий server.js как отдельный процесс на временной БД
 * (NETMONITOR_DB_PATH указывает на файл в os.tmpdir(), никогда не трогает
 * реальную data/netmonitor.db) и гоняет через него реальные HTTP-запросы.
 *
 * Включает регрессионный тест на баг с роутингом (см. CHANGELOG/историю):
 * /api/categories и /api/sites раньше были недостижимы (404), потому что
 * их роуты жили в devices.js, который монтируется на /api/devices, а не /api.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 19222 + (process.pid % 500); // разносим порт по PID, чтобы не конфликтовать при параллельных прогонах
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `netmonitor-itest-${process.pid}-${Date.now()}.db`);

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

describe('NetMonitor API (интеграционные тесты через реальный сервер)', () => {
  before(async () => {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: {
        ...process.env,
        NETMONITOR_DB_PATH: tmpDb,
        HTTP_REDIRECT_PORT: String(PORT),
        NO_BROWSER: '1',
        PORT: '0' // без HTTPS-порта — форсируем чистый HTTP режим на REDIRECT_PORT
      },
      stdio: 'pipe'
    });
    await waitForServer();

    // Логин дефолтным admin + обязательная смена пароля (иначе все остальные запросы получат 403)
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'TestPass123456' }) });
  });

  after(() => {
    if (serverProcess) serverProcess.kill('SIGKILL');
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
    try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  });

  test('логин с неверным паролем отклоняется', async () => {
    const prevCookie = sessionCookie;
    sessionCookie = '';
    const res = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    assert.equal(res.status, 401);
    sessionCookie = prevCookie;
  });

  test('РЕГРЕССИЯ: логин с пустым телом отвечает 401, а не виснет без ответа', async () => {
    const prevCookie = sessionCookie;
    sessionCookie = '';
    const res = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401, 'до фикса node:sqlite бросал исключение на undefined username, зависая без ответа (Express 4 не ловит ошибки в async-роутах автоматически)');
    sessionCookie = prevCookie;
  });

  test('РЕГРЕССИЯ: /api/categories отвечает JSON, а не 404 (баг с монтированием роутера)', async () => {
    const res = await api('/api/categories');
    assert.equal(res.status, 200, '/api/categories должен быть доступен напрямую под /api, а не только /api/devices/categories');
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length > 0, 'должны быть дефолтные категории');
  });

  test('РЕГРЕССИЯ: /api/sites отвечает JSON, а не 404', async () => {
    const res = await api('/api/sites');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  test('создание площадки (Multi-site) через /api/sites', async () => {
    const res = await api('/api/sites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sites: [{ name: 'Москва (офис)', color: '#3b82f6', address: 'ул. Ленина 1' }] })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].name, 'Москва (офис)');
  });

  test('нельзя удалить площадку, используемую устройством', async () => {
    const sites = await api('/api/sites').then(r => r.json());
    const siteId = sites[0].id;

    await api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Router-Test', ip: '10.0.0.99', site: siteId, monitored: true })
    });

    const res = await api('/api/sites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sites: [] }) // пытаемся удалить всё, включая используемую площадку
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'site_in_use');
  });

  test('устройство создаётся и появляется в /api/devices', async () => {
    const res = await api('/api/devices');
    assert.equal(res.status, 200);
    const devices = await res.json();
    const created = devices.find(d => d.name === 'Router-Test');
    assert.ok(created, 'устройство Router-Test должно быть в списке');
    assert.equal(created.ip, '10.0.0.99');
  });

  test('дашборд-виджеты отвечают и содержат ожидаемые поля', async () => {
    const res = await api('/api/dashboard/widgets');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok('online' in data);
    assert.ok('totalMonitored' in data);
    assert.ok(Array.isArray(data.heatmap));
  });

  test('аудит-лог: поиск по подстроке фильтрует записи', async () => {
    // Аудит-лог выключен по умолчанию (features.auditLog: false) — включаем явно
    await api('/api/features', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auditLog: true })
    });
    // Действие, которое должно попасть в лог теперь, когда фича включена
    await api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuditLogTestDevice', ip: '10.0.0.77', monitored: false })
    });

    const all = await api('/api/audit-log?pageSize=100').then(r => r.json());
    assert.ok(all.total > 0, 'после включения фичи и создания устройства должны быть записи в аудит-логе');

    const filtered = await api('/api/audit-log?search=AuditLogTestDevice').then(r => r.json());
    assert.ok(filtered.total > 0, 'поиск по имени устройства должен найти запись о его создании');
    assert.ok(filtered.entries.every(e => e.details.includes('AuditLogTestDevice') || e.action.includes('device')));
  });

  test('неавторизованный запрос отклоняется без сессии', async () => {
    const prevCookie = sessionCookie;
    sessionCookie = '';
    const res = await api('/api/devices');
    assert.equal(res.status, 401);
    sessionCookie = prevCookie;
  });
});
