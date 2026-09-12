'use strict';
/**
 * test/unit/discovery-lldp.test.js
 *
 * src/routes/discovery.js делает `require('../services/lldpCdp')` ЛЕНИВО
 * внутри обработчика POST /topology/build-snmp/:deviceId (не при загрузке
 * модуля) — поэтому монтируем роутер напрямую в мини-express (как в
 * traffic.test.js/sse.test.js) и подменяем lldpCdp.js в require.cache
 * ДО первого обращения к этому роуту в этом процессе.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const express = require('express');

const tmpDb = path.join(os.tmpdir(), `netmonitor-discoverylldptest-${process.pid}-${Date.now()}.db`);
process.env.NETMONITOR_DB_PATH = tmpDb;
process.env.RATE_LIMIT_DISABLED = 'true';

let neighborsBehavior = {};
const lldpCdpPath = require.resolve('../../src/services/lldpCdp');
require.cache[lldpCdpPath] = {
  id: lldpCdpPath, filename: lldpCdpPath, loaded: true,
  exports: {
    discoverNeighbors: async (device) => {
      neighborsBehavior.lastDevice = device;
      if (neighborsBehavior.shouldThrow) throw new Error('SNMP timeout');
      return neighborsBehavior.result || [];
    }
  }
};

const { db, newId } = require('../../src/db');
const discoveryRouter = require('../../src/routes/discovery');

let server, BASE;

async function api(pathname, opts = {}) {
  return fetch(`${BASE}${pathname}`, opts);
}

describe('discovery.js: POST /topology/build-snmp/:deviceId (фейковый discoverNeighbors)', () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { userId: 'admin' }; next(); });
    app.use('/api/discovery', discoveryRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    BASE = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.close();
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
    try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  });

  beforeEach(() => { neighborsBehavior = {}; });

  test('несуществующее устройство — 404', async () => {
    const res = await api('/api/discovery/topology/build-snmp/no-such-device', { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('устройство без включённого SNMP — 400 snmp_disabled', async () => {
    const id = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,snmp_enabled) VALUES (?,?,?,?,0)").run(id, 'NoSnmp', '10.0.0.1', 'other');
    const res = await api(`/api/discovery/topology/build-snmp/${id}`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'snmp_disabled');
  });

  test('discoverNeighbors падает (SNMP timeout) — 500 snmp_failed, не молчаливый краш', async () => {
    neighborsBehavior.shouldThrow = true;
    const id = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,snmp_enabled) VALUES (?,?,?,?,1)").run(id, 'SnmpSrc', '10.0.0.2', 'other');
    const res = await api(`/api/discovery/topology/build-snmp/${id}`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'snmp_failed');
  });

  test('соседей не найдено — ok:true, edgesCreated:0, без ошибки', async () => {
    neighborsBehavior.result = [];
    const id = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,snmp_enabled) VALUES (?,?,?,?,1)").run(id, 'SnmpSrc2', '10.0.0.3', 'other');
    const res = await api(`/api/discovery/topology/build-snmp/${id}`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.edgesCreated, 0);
  });

  test('сосед с известным IP находится в реестре — связь создаётся с существующим устройством, новое не создаётся', async () => {
    const srcId = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,snmp_enabled) VALUES (?,?,?,?,1)").run(srcId, 'SnmpSrc3', '10.0.0.4', 'other');
    const existingId = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id) VALUES (?,?,?,?)").run(existingId, 'ExistingNeighbor', '10.0.0.5', 'other');

    neighborsBehavior.result = [{ remoteIp: '10.0.0.5', remoteName: 'ExistingNeighbor', remotePort: 'Gi0/1', localPortDesc: 'Gi0/2', source: 'LLDP' }];
    const devCountBefore = db.prepare('SELECT COUNT(*) c FROM devices').get().c;

    const res = await api(`/api/discovery/topology/build-snmp/${srcId}`, { method: 'POST' });
    const data = await res.json();
    assert.equal(data.edgesCreated, 1);
    assert.equal(data.protocol, 'LLDP');

    const devCountAfter = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
    assert.equal(devCountAfter, devCountBefore, 'известный по IP сосед не должен создавать дубликат устройства');

    const edge = db.prepare('SELECT * FROM topology_edges WHERE from_id=? AND to_id=?').get(srcId, existingId);
    assert.ok(edge);
    assert.match(edge.label, /Gi0\/2.*Gi0\/1/);
  });

  test('сосед без известного IP/имени в реестре — создаётся новое устройство-заглушка', async () => {
    const srcId = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,snmp_enabled) VALUES (?,?,?,?,1)").run(srcId, 'SnmpSrc4', '10.0.0.6', 'other');
    neighborsBehavior.result = [{ remoteIp: '10.0.0.200', remoteName: 'BrandNewSwitch', remotePlatform: 'Cisco IOS', source: 'CDP' }];

    const res = await api(`/api/discovery/topology/build-snmp/${srcId}`, { method: 'POST' });
    const data = await res.json();
    assert.equal(data.edgesCreated, 1);

    const created = db.prepare("SELECT * FROM devices WHERE ip='10.0.0.200'").get();
    assert.ok(created, 'новое устройство-заглушка должно быть создано для неизвестного соседа');
    assert.equal(created.name, 'BrandNewSwitch');
    assert.equal(created.monitored, 0, 'заглушка-сосед не должна мониториться автоматически');
  });

  test('повторный вызов удаляет старые связи от этого источника перед созданием новых (не копится мусор)', async () => {
    const srcId = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,snmp_enabled) VALUES (?,?,?,?,1)").run(srcId, 'SnmpSrc5', '10.0.0.7', 'other');
    neighborsBehavior.result = [{ remoteIp: '10.0.0.201', remoteName: 'Neighbor1' }];
    await api(`/api/discovery/topology/build-snmp/${srcId}`, { method: 'POST' });
    let count = db.prepare('SELECT COUNT(*) c FROM topology_edges WHERE from_id=?').get(srcId).c;
    assert.equal(count, 1);

    neighborsBehavior.result = [{ remoteIp: '10.0.0.202', remoteName: 'Neighbor2' }];
    await api(`/api/discovery/topology/build-snmp/${srcId}`, { method: 'POST' });
    count = db.prepare('SELECT COUNT(*) c FROM topology_edges WHERE from_id=?').get(srcId).c;
    assert.equal(count, 1, 'старая связь (via_router_id=snmp:srcId) должна быть удалена перед вставкой новых');
  });

  test('сосед сам является источником (self-loop) — пропускается, связь не создаётся', async () => {
    const srcId = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,snmp_enabled) VALUES (?,?,?,?,1)").run(srcId, 'SelfLoop', '10.0.0.8', 'other');
    neighborsBehavior.result = [{ remoteIp: '10.0.0.8', remoteName: 'SelfLoop' }]; // указывает сам на себя
    const res = await api(`/api/discovery/topology/build-snmp/${srcId}`, { method: 'POST' });
    const data = await res.json();
    assert.equal(data.edgesCreated, 0);
  });
});
