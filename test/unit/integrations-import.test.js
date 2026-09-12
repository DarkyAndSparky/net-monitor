'use strict';
/**
 * test/unit/integrations-import.test.js
 *
 * src/routes/integrations.js делает реальные вызовы к внешнему сетевому
 * оборудованию: RouterOS API (MikroTik), HTTPS (UniFi controller), SSH
 * (Cisco). Ни один протокол не поднять в этой песочнице — как и с ldapts/
 * net-snmp в других файлах, подменяем зависимости ДО того, как
 * integrations.js их потребует:
 *  - 'node-routeros' → фейковый RouterOSAPI (top-level require в файле)
 *  - 'ssh2' → фейковый Client (тоже top-level, но за try/catch)
 *  - 'https' (встроенный модуль) → монкипатчим request() напрямую, это
 *    синглтон, поэтому подмена видна и внутри integrations.js без require.cache
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const express = require('express');

const tmpDb = path.join(os.tmpdir(), `netmonitor-integrationsimporttest-${process.pid}-${Date.now()}.db`);
process.env.NETMONITOR_DB_PATH = tmpDb;

// ── Фейковый node-routeros ──────────────────────────────────────────────
let routerosBehavior = {};
const routerosPath = require.resolve('node-routeros');
class FakeRouterOSAPI {
  constructor(opts) { routerosBehavior.lastOpts = opts; }
  async connect() { if (routerosBehavior.connectShouldThrow) throw new Error(routerosBehavior.connectError || 'connect failed'); }
  async write(command) {
    routerosBehavior.lastCommand = command;
    if (routerosBehavior.writeShouldThrow) throw new Error('write failed');
    return (routerosBehavior.results && routerosBehavior.results[command]) || [];
  }
  close() { routerosBehavior.closed = (routerosBehavior.closed || 0) + 1; }
}
require.cache[routerosPath] = { id: routerosPath, filename: routerosPath, loaded: true, exports: { RouterOSAPI: FakeRouterOSAPI } };

// ── Фейковый ssh2 ────────────────────────────────────────────────────────
let sshBehavior = {};
const ssh2Path = require.resolve('ssh2');
class FakeSSHClient extends EventEmitter {
  connect(opts) {
    sshBehavior.lastConnectOpts = opts;
    if (sshBehavior.connectShouldError) { process.nextTick(() => this.emit('error', new Error(sshBehavior.connectError || 'ssh connect failed'))); return; }
    process.nextTick(() => this.emit('ready'));
  }
  exec(command, cb) {
    sshBehavior.lastCommand = command;
    if (sshBehavior.execShouldError) return cb(new Error('exec failed'));
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    cb(null, stream);
    process.nextTick(() => {
      if (sshBehavior.output != null) stream.emit('data', Buffer.from(sshBehavior.output));
      stream.emit('close');
    });
  }
  end() { sshBehavior.ended = (sshBehavior.ended || 0) + 1; }
}
require.cache[ssh2Path] = { id: ssh2Path, filename: ssh2Path, loaded: true, exports: { Client: FakeSSHClient } };

const { db, newId, setSetting } = require('../../src/db');
const integrationsRouter = require('../../src/routes/integrations');

// ── Монкипатч https.request для UniFi ────────────────────────────────────
const realHttpsRequest = https.request;
let httpsBehavior = {};
function installFakeHttps() {
  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {
      const key = options.path;
      const responder = httpsBehavior[key] || httpsBehavior.default;
      if (!responder) { process.nextTick(() => req.emit('error', new Error('no fake response configured for ' + key))); return; }
      const result = responder(options);
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = result.statusCode;
        res.headers = result.headers || {};
        callback(res);
        process.nextTick(() => {
          if (result.body != null) res.emit('data', Buffer.from(JSON.stringify(result.body)));
          res.emit('end');
        });
      });
    };
    return req;
  };
}

let server, BASE;
async function api(pathname, opts = {}) { return fetch(`${BASE}${pathname}`, opts); }

describe('integrations.js: реальные импорты (RouterOS/SSH/HTTPS замоканы)', () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { userId: 'admin' }; next(); });
    app.use('/api', integrationsRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    BASE = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    https.request = realHttpsRequest;
    server?.close();
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
    try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  });

  beforeEach(() => { routerosBehavior = {}; sshBehavior = {}; httpsBehavior = {}; installFakeHttps(); });

  // ── MikroTik ──────────────────────────────────────────────────────────
  test('MikroTik import: без host/password — connection_failed not_configured (RouterOS даже не вызывается)', async () => {
    setSetting('mikrotiks', [{ id: 'r1', name: 'R1', host: '', password: '' }]);
    const res = await api('/api/mikrotik/routers/r1/import', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'not_configured');
    assert.equal(routerosBehavior.lastOpts, undefined);
  });

  test('MikroTik import: RouterOS недоступен (connect падает) — 500 connection_failed', async () => {
    routerosBehavior.connectShouldThrow = true;
    setSetting('mikrotiks', [{ id: 'r2', name: 'R2', host: '10.0.0.1', password: 'x' }]);
    const res = await api('/api/mikrotik/routers/r2/import', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'connection_failed');
  });

  test('MikroTik import: успешный импорт DHCP-лизов создаёт новые устройства и обновляет существующие', async () => {
    const existingId = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,mac,category_id) VALUES (?,?,?,?,?)").run(existingId, 'OldName', '10.0.0.50', 'AA:BB:CC:DD:EE:01', 'other');
    routerosBehavior.results = { '/ip/dhcp-server/lease/print': [
      { 'mac-address': 'aa:bb:cc:dd:ee:01', address: '10.0.0.51', 'host-name': 'renamed-host' }, // существующий по MAC → апдейт
      { 'mac-address': 'aa:bb:cc:dd:ee:99', address: '10.0.0.99', 'host-name': 'brand-new' },     // новый → создание
    ] };
    setSetting('mikrotiks', [{ id: 'r3', name: 'R3', host: '10.0.0.1', password: 'x' }]);
    const res = await api('/api/mikrotik/routers/r3/import', { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.created, 1);
    assert.equal(data.updated, 1);
    assert.equal(data.total, 2);

    const updated = db.prepare('SELECT * FROM devices WHERE id=?').get(existingId);
    assert.equal(updated.ip, '10.0.0.51', 'существующее устройство должно обновить IP по MAC-совпадению');

    const created = db.prepare("SELECT * FROM devices WHERE ip='10.0.0.99'").get();
    assert.ok(created);
    assert.equal(created.name, 'brand-new');
    assert.ok(routerosBehavior.closed >= 1, 'соединение должно закрываться после импорта');
  });

  test('MikroTik ARP: сопоставляет найденные записи с уже существующими устройствами', async () => {
    const existingId = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,mac,category_id) VALUES (?,?,?,?,?)").run(existingId, 'KnownHost', '10.0.0.60', 'AA:BB:CC:DD:EE:02', 'other');
    routerosBehavior.results = { '/ip/arp/print': [
      { address: '10.0.0.60', 'mac-address': 'aa:bb:cc:dd:ee:02', interface: 'ether1' },
      { address: '10.0.0.200', 'mac-address': 'aa:bb:cc:dd:ee:03', interface: 'ether2' },
    ] };
    setSetting('mikrotiks', [{ id: 'r4', name: 'R4', host: '10.0.0.1', password: 'x' }]);
    const res = await api('/api/mikrotik/routers/r4/arp', { method: 'POST' });
    const data = await res.json();
    assert.equal(data.results.length, 2);
    assert.equal(data.results[0].existingDeviceId, existingId);
    assert.equal(data.results[1].existingDeviceId, null);
  });

  test('MikroTik neighbors: маппит identity/platform/board из ответа', async () => {
    routerosBehavior.results = { '/ip/neighbor/print': [
      { identity: 'sw-core-01', address: '10.0.0.2', 'mac-address': 'aa:bb:cc:00:00:01', platform: 'MikroTik', board: 'RB4011', interface: 'ether1' },
    ] };
    setSetting('mikrotiks', [{ id: 'r5', name: 'R5', host: '10.0.0.1', password: 'x' }]);
    const res = await api('/api/mikrotik/routers/r5/neighbors', { method: 'POST' });
    const data = await res.json();
    assert.equal(data.results[0].identity, 'sw-core-01');
    assert.equal(data.results[0].board, 'RB4011');
  });

  test('mikrotik/import-all: агрегирует результаты нескольких роутеров, включая частичный отказ', async () => {
    setSetting('mikrotiks', [
      { id: 'ok1', name: 'OK-Router', host: '10.0.0.1', password: 'x' },
      { id: 'bad1', name: 'Bad-Router', host: '10.0.0.2', password: 'x' },
    ]);
    routerosBehavior.results = { '/ip/dhcp-server/lease/print': [] };
    let callCount = 0;
    const origWrite = FakeRouterOSAPI.prototype.write;
    FakeRouterOSAPI.prototype.write = async function (command) {
      callCount++;
      if (callCount === 2) throw new Error('second router unreachable');
      return [];
    };
    try {
      const res = await api('/api/mikrotik/import-all', { method: 'POST' });
      const data = await res.json();
      assert.equal(data.results.length, 2);
      assert.equal(data.results[0].ok, true);
      assert.equal(data.results[1].ok, false);
      assert.match(data.results[1].message, /unreachable/);
    } finally {
      FakeRouterOSAPI.prototype.write = origWrite;
    }
  });

  // ── UniFi ─────────────────────────────────────────────────────────────
  test('UniFi import: неверные логин/пароль — 500 unifi_login_failed', async () => {
    httpsBehavior['/api/login'] = () => ({ statusCode: 401, headers: {}, body: { error: 'invalid' } });
    setSetting('unifiControllers', [{ id: 'u1', name: 'U1', host: '10.0.0.10', user: 'admin', password: 'wrong' }]);
    const res = await api('/api/unifi/controllers/u1/import', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'unifi_login_failed');
  });

  test('UniFi import: успешный логин без cookie сессии — unifi_no_session', async () => {
    httpsBehavior['/api/login'] = () => ({ statusCode: 200, headers: {}, body: {} }); // нет set-cookie
    setSetting('unifiControllers', [{ id: 'u2', name: 'U2', host: '10.0.0.10', user: 'admin', password: 'x' }]);
    const res = await api('/api/unifi/controllers/u2/import', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'unifi_no_session');
  });

  test('UniFi import: полный успешный путь — устройства инфраструктуры и клиенты создаются', async () => {
    httpsBehavior['/api/login'] = () => ({ statusCode: 200, headers: { 'set-cookie': ['unifises=abc123; Path=/'] }, body: {} });
    httpsBehavior['/api/s/default/stat/device'] = () => ({ statusCode: 200, headers: {}, body: { data: [{ mac: 'aa:bb:cc:11:11:11', ip: '10.0.0.20', name: 'AP-Lobby', model: 'U6-Lite', type: 'uap' }] } });
    httpsBehavior['/api/s/default/stat/sta'] = () => ({ statusCode: 200, headers: {}, body: { data: [{ mac: 'aa:bb:cc:22:22:22', ip: '10.0.0.21', hostname: 'laptop-1', is_wired: false }] } });
    setSetting('unifiControllers', [{ id: 'u3', name: 'U3', host: '10.0.0.10', user: 'admin', password: 'x', site: 'default' }]);

    const res = await api('/api/unifi/controllers/u3/import', { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.created, 2);
    assert.equal(data.total, 2);

    const ap = db.prepare("SELECT * FROM devices WHERE ip='10.0.0.20'").get();
    assert.equal(ap.name, 'AP-Lobby');
    assert.equal(ap.category_id, 'network', 'uap-тип должен маппиться в категорию network');

    const client = db.prepare("SELECT * FROM devices WHERE ip='10.0.0.21'").get();
    assert.equal(client.name, 'laptop-1');
    assert.equal(client.category_id, 'workstation', 'клиент (не uap/usw/ugw/udm) должен маппиться в workstation');
  });

  test('UniFi UniFi OS контроллер использует /api/auth/login и префикс /proxy/network', async () => {
    httpsBehavior['/api/auth/login'] = () => ({ statusCode: 200, headers: { 'set-cookie': ['TOKEN=xyz; Path=/'] }, body: {} });
    httpsBehavior['/proxy/network/api/s/default/stat/device'] = () => ({ statusCode: 200, headers: {}, body: { data: [] } });
    httpsBehavior['/proxy/network/api/s/default/stat/sta'] = () => ({ statusCode: 200, headers: {}, body: { data: [] } });
    setSetting('unifiControllers', [{ id: 'u4', name: 'U4', host: '10.0.0.11', user: 'admin', password: 'x', unifiOS: true }]);
    const res = await api('/api/unifi/controllers/u4/import', { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.total, 0);
  });

  // ── Cisco SSH ─────────────────────────────────────────────────────────
  test('Cisco import: SSH-соединение падает — 500 connection_failed', async () => {
    sshBehavior.connectShouldError = true;
    setSetting('ciscoDevices', [{ id: 'c1', name: 'C1', host: '10.0.0.30', user: 'admin', password: 'x' }]);
    const res = await api('/api/cisco/devices/c1/import', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'connection_failed');
  });

  test('Cisco import: успешный вывод "show ip arp" парсится и создаёт устройства', async () => {
    sshBehavior.output = [
      'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
      'Internet  10.0.0.40              -   0011.2233.4455  ARPA   GigabitEthernet0/1',
      'Internet  10.0.0.41              5   0011.2233.4456  ARPA   GigabitEthernet0/2',
    ].join('\n');
    setSetting('ciscoDevices', [{ id: 'c2', name: 'C2', host: '10.0.0.30', user: 'admin', password: 'x' }]);
    const res = await api('/api/cisco/devices/c2/import', { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.created, 2);
    assert.equal(sshBehavior.lastCommand, 'show ip arp');

    const dev = db.prepare("SELECT * FROM devices WHERE ip='10.0.0.40'").get();
    assert.equal(dev.mac, '00:11:22:33:44:55');
    assert.match(dev.comment, /GigabitEthernet0\/1/);
  });

  test('Cisco import: пустой/неразбираемый вывод ARP — 500 parse_failed', async () => {
    sshBehavior.output = 'Command not recognized or garbage output';
    setSetting('ciscoDevices', [{ id: 'c3', name: 'C3', host: '10.0.0.30', user: 'admin', password: 'x' }]);
    const res = await api('/api/cisco/devices/c3/import', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'parse_failed');
  });

  test('Cisco import: SSH-сессия закрывается после выполнения (end() вызван)', async () => {
    sshBehavior.output = 'Internet  10.0.0.42   -   0011.2233.4457  ARPA   Gi0/3';
    setSetting('ciscoDevices', [{ id: 'c4', name: 'C4', host: '10.0.0.30', user: 'admin', password: 'x' }]);
    await api('/api/cisco/devices/c4/import', { method: 'POST' });
    assert.ok(sshBehavior.ended >= 1);
  });
});
