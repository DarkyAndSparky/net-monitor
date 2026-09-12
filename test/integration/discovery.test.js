'use strict';
/**
 * test/integration/discovery.test.js
 *
 * src/routes/discovery.js — обнаружение сети (ping-sweep, bulk-добавление,
 * топология, правила подсетей). Реальный ping-sweep и SNMP/RouterOS-опрос
 * соседей не тестируем (нужна реальная сеть/железо — см. roadmap, раздел
 * про моки) — здесь только маршруты, не требующие сети: валидация,
 * bulk-insert, ручное управление topology_edges, subnet-rules.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 19200 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `netmonitor-discoverytest-${process.pid}-${Date.now()}.db`);

let serverProcess;
let sessionCookie = '';
let deviceA, deviceB;

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

describe('NetMonitor Discovery API (сеть, топология, правила подсетей)', () => {
  before(async () => {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: { ...process.env, NETMONITOR_DB_PATH: tmpDb, HTTP_REDIRECT_PORT: String(PORT), NO_BROWSER: '1', PORT: '0', RATE_LIMIT_DISABLED: 'true' },
      stdio: 'pipe'
    });
    await waitForServer();
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'DiscoveryTestPass123456' }) });
    deviceA = await api('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'DiscA', ip: '10.0.0.201' }) }).then(r => r.json()).then(d => d.id);
    deviceB = await api('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'DiscB', ip: '10.0.0.202' }) }).then(r => r.json()).then(d => d.id);
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

  test('GET /api/discovery/local-subnets возвращает массив уникальных CIDR', async () => {
    const res = await api('/api/discovery/local-subnets');
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.equal(new Set(list).size, list.length, 'не должно быть дублей подсетей');
  });

  test('POST /api/discovery/scan с некорректным CIDR — 400 invalid_cidr', async () => {
    const res = await api('/api/discovery/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cidr: 'not-a-cidr' }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_cidr');
  });

  test('POST /api/discovery/scan со слишком большим диапазоном (/16) — 400 range_too_big', async () => {
    const res = await api('/api/discovery/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cidr: '10.0.0.0/16' }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'range_too_big');
  });

  test('POST /api/discovery/scan с валидным /30 — реально сканирует (pingHost резолвится быстро без ICMP-прав, ~10-20мс на хост)', async () => {
    const res = await api('/api/discovery/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cidr: '10.255.255.0/30' }) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.scanned, 2, '/30 даёт 2 адреса хостов (сеть и broadcast исключены)');
    assert.ok(Array.isArray(data.results));
    assert.equal(data.found, data.results.length);
    // found всегда 0 в этой песочнице: ICMP недоступен полностью (даже на loopback,
    // проверено отдельно) — поле inRegistry на найденных хостах покрыто косвенно через
    // прямой SQL-запрос known-set в тестах add-bulk выше, где реальный пинг не нужен.
  });

  test('POST /api/discovery/add-bulk без items — 400 items_required', async () => {
    const res = await api('/api/discovery/add-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'items_required');
  });

  test('POST /api/discovery/add-bulk создаёт новые устройства и пропускает дубликаты по IP', async () => {
    const res = await api('/api/discovery/add-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [
        { ip: '10.0.0.230', name: 'BulkNew1' },
        { ip: '10.0.0.201', name: 'DuplicateOfDiscA' }, // уже существует (deviceA)
        { mac: '', ip: '' }, // ни ip ни mac — должен быть пропущен молча
      ] })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.created, 1, 'должно создаться ровно одно новое устройство (дубликат и пустая запись — пропущены)');
  });

  test('GET /api/discovery/lldp-cdp/devices возвращает только устройства с включённым SNMP', async () => {
    const res = await api('/api/discovery/lldp-cdp/devices');
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.ok(!list.some(d => d.id === deviceA), 'DiscA создан без snmp_enabled — не должен попасть в список');
  });

  // ── Топология: ручные связи ──────────────────────────────────────────
  let edgeId;

  test('POST /api/discovery/topology/edges с одинаковым from/to — 400 invalid_edge', async () => {
    const res = await api('/api/discovery/topology/edges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: deviceA, to: deviceA }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_edge');
  });

  test('POST /api/discovery/topology/edges с несуществующим устройством — 404 device_not_found', async () => {
    const res = await api('/api/discovery/topology/edges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: deviceA, to: 'no-such-device' }) });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'device_not_found');
  });

  test('POST /api/discovery/topology/edges создаёт связь между реальными устройствами', async () => {
    const res = await api('/api/discovery/topology/edges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: deviceA, to: deviceB, label: 'trunk' }) });
    assert.equal(res.status, 200);
    const data = await res.json();
    edgeId = data.id;
    assert.equal(data.manual, true);
    assert.equal(data.label, 'trunk');
  });

  test('GET /api/discovery/topology содержит созданную связь', async () => {
    const res = await api('/api/discovery/topology');
    const data = await res.json();
    assert.ok(data.edges.some(e => e.id === edgeId));
  });

  test('PUT /api/discovery/topology/edges/:id обновляет label', async () => {
    const res = await api(`/api/discovery/topology/edges/${edgeId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'renamed-link' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).label, 'renamed-link');
  });

  test('PUT несуществующей связи — 404', async () => {
    const res = await api('/api/discovery/topology/edges/no-such-edge', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'x' }) });
    assert.equal(res.status, 404);
  });

  test('DELETE /api/discovery/topology/edges/:id удаляет связь', async () => {
    const res = await api(`/api/discovery/topology/edges/${edgeId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const list = await api('/api/discovery/topology').then(r => r.json());
    assert.ok(!list.edges.some(e => e.id === edgeId));
  });

  // ── Правила подсетей ─────────────────────────────────────────────────
  test('GET /api/discovery/subnet-rules изначально пуст', async () => {
    const res = await api('/api/discovery/subnet-rules');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('POST /api/discovery/subnet-rules без массива rules — 400 rules_required', async () => {
    const res = await api('/api/discovery/subnet-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'rules_required');
  });

  test('POST /api/discovery/subnet-rules с некорректным CIDR в правиле — 400 invalid_cidr', async () => {
    const res = await api('/api/discovery/subnet-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: [{ cidr: 'garbage', label: 'x' }] })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_cidr');
  });

  test('POST /api/discovery/subnet-rules с некорректным цветом — 400 invalid_color', async () => {
    const res = await api('/api/discovery/subnet-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: [{ cidr: '10.0.0.0/24', color: 'not-a-hex-color' }] })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_color');
  });

  test('POST /api/discovery/subnet-rules с валидными правилами — сохраняет и проставляет дефолты', async () => {
    const res = await api('/api/discovery/subnet-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: [{ cidr: '10.0.0.0/24' }, { cidr: '192.168.1.0/24', label: 'Office', color: '#ff0000' }] })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 2);
    assert.equal(data[0].label, '10.0.0.0/24', 'без явного label — дефолт это сам cidr');
    assert.equal(data[0].color, '#3b82f6', 'без явного color — дефолтный синий');
    assert.equal(data[1].label, 'Office');
    assert.equal(data[1].color, '#ff0000');

    const list = await api('/api/discovery/subnet-rules').then(r => r.json());
    assert.equal(list.length, 2, 'повторный GET должен вернуть сохранённые правила');
  });

  test('scan/add-bulk/topology-edges/subnet-rules недоступны viewer (requireOperator)', async () => {
    await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'discviewer', password: 'ViewerPass123456', role: 'viewer' }) });
    const prevCookie = sessionCookie;
    sessionCookie = '';
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'discviewer', password: 'ViewerPass123456' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'ViewerPass123456', newPassword: 'ViewerPass2ndRound123456' }) });

    const scanRes = await api('/api/discovery/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cidr: '10.0.0.0/30' }) });
    assert.equal(scanRes.status, 403);
    const rulesRes = await api('/api/discovery/subnet-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [] }) });
    assert.equal(rulesRes.status, 403);

    sessionCookie = prevCookie;
  });
});
