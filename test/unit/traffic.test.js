'use strict';
/**
 * test/unit/traffic.test.js
 *
 * src/routes/traffic.js только читает traffic_history — данные туда пишет
 * scheduler.js по реальному SNMP/MikroTik-опросу, которого в этой песочнице
 * нет (см. metrics.test.js/discovery.test.js про отсутствие ICMP — то же
 * верно для SNMP). Поэтому тестируем не через полный HTTP-сервер, а монтируя
 * роутер напрямую в мини-express с фейковой сессией и вставляя фикстуры
 * прямо в БД через тот же модуль src/db, что использует сам роут.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDb = path.join(os.tmpdir(), `netmonitor-traffictest-${process.pid}-${Date.now()}.db`);
process.env.NETMONITOR_DB_PATH = tmpDb;
process.env.RATE_LIMIT_DISABLED = 'true';

const { db, setSetting } = require('../../src/db');
const trafficRouter = require('../../src/routes/traffic');
const express = require('express');

let server, BASE;

async function api(pathname) {
  return fetch(`${BASE}${pathname}`);
}

describe('traffic.js (unit, фикстуры напрямую в БД)', () => {
  before(async () => {
    const app = express();
    app.use((req, res, next) => { req.session = { userId: 'admin' }; next(); }); // фейковая сессия — обходит requireAuth без реального логина
    app.use('/api/traffic', trafficRouter);
    server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    BASE = `http://127.0.0.1:${server.address().port}`;

    db.prepare("INSERT INTO devices (id,name,ip,category_id,check_interval,alerts_enabled,snmp_if_index) VALUES ('devA','Device A','10.0.0.1','other',60,1,1)").run();
    db.prepare("INSERT INTO devices (id,name,ip,category_id,check_interval,alerts_enabled) VALUES ('devB','Device B (no SNMP if)','10.0.0.2','other',60,1)").run(); // snmp_if_index=NULL — не должен попасть в /current
  });

  after(() => {
    server?.close();
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
    try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  });

  test('GET /api/traffic/current с выключенной фичей — enabled:false, пустые массивы', async () => {
    const res = await api('/api/traffic/current');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { enabled: false, devices: [], routers: [] });
  });

  test('GET /api/traffic/current с включённой фичей, но без данных — пустые массивы, не падает', async () => {
    setSetting('features', { traffic: true });
    const res = await api('/api/traffic/current');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, true);
    assert.deepEqual(data.devices, []);
    assert.deepEqual(data.routers, []);
  });

  test('GET /api/traffic/current возвращает только САМУЮ ПОСЛЕДНЮЮ точку по устройству', async () => {
    const now = Date.now();
    const ins = db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)');
    ins.run('device', 'devA', '', now - 60000, 100, 50);
    ins.run('device', 'devA', '', now - 30000, 200, 80);
    ins.run('device', 'devA', '', now, 300, 120); // самая свежая — должна попасть в ответ

    const res = await api('/api/traffic/current');
    const data = await res.json();
    assert.equal(data.devices.length, 1);
    assert.equal(data.devices[0].id, 'devA');
    assert.equal(data.devices[0].rxBps, 300);
    assert.equal(data.devices[0].txBps, 120);
    assert.equal(data.devices[0].ts, now);
  });

  test('devB без snmp_if_index не попадает в /current, даже если для него есть traffic_history', async () => {
    db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)').run('device', 'devB', '', Date.now(), 999, 999);
    const res = await api('/api/traffic/current');
    const data = await res.json();
    assert.ok(!data.devices.some(d => d.id === 'devB'), 'устройство без snmp_if_index не должно появляться в /current — оно не мониторится по трафику');
  });

  test('/current для роутера: имя берётся из настройки mikrotiks, фоллбек на id, если конфиг не найден', async () => {
    setSetting('mikrotiks', [{ id: 'rtr1', name: 'Core Router' }]);
    const now = Date.now();
    db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)').run('router', 'rtr1', 'ether1', now, 500, 200);
    db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)').run('router', 'rtr-unknown', 'ether2', now, 10, 5);

    const res = await api('/api/traffic/current');
    const data = await res.json();
    const known = data.routers.find(r => r.routerId === 'rtr1');
    const unknown = data.routers.find(r => r.routerId === 'rtr-unknown');
    assert.equal(known.routerName, 'Core Router');
    assert.equal(unknown.routerName, 'rtr-unknown', 'без записи в конфиге mikrotiks — фоллбек на сам id роутера');
  });

  test('GET /api/traffic/device/:id — история, отфильтрованная по диапазону (range=1h)', async () => {
    const now = Date.now();
    db.prepare('DELETE FROM traffic_history').run();
    const ins = db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)');
    ins.run('device', 'devA', '', now - 2 * 3600e3, 1, 1);  // за пределами 1h — не должно попасть
    ins.run('device', 'devA', '', now - 30 * 60e3, 2, 2);   // в пределах 1h

    const res = await api('/api/traffic/device/devA?range=1h');
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].rx, 2);
  });

  test('GET /api/traffic/device/:id без range — дефолт 24h', async () => {
    const now = Date.now();
    db.prepare('DELETE FROM traffic_history').run();
    db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)').run('device', 'devA', '', now - 12 * 3600e3, 5, 5);
    const res = await api('/api/traffic/device/devA');
    const data = await res.json();
    assert.equal(data.length, 1, 'без явного range должна использоваться дефолтная 24ч граница');
  });

  test('GET /api/traffic/device/:id для устройства без истории — пустой массив', async () => {
    const res = await api('/api/traffic/device/no-such-device');
    assert.deepEqual(await res.json(), []);
  });

  test('РЕГРЕССИЯ: downsample() сокращает большую историю до ≤200 точек, сохраняя порядок и крайние точки', async () => {
    db.prepare('DELETE FROM traffic_history').run();
    const ins = db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)');
    const now = Date.now();
    const N = 500;
    for (let i = 0; i < N; i++) {
      ins.run('device', 'devA', '', now - (N - i) * 1000, i, i); // rx=i, монотонно возрастает — удобно проверить порядок
    }
    const res = await api('/api/traffic/device/devA?range=7d');
    const data = await res.json();
    assert.ok(data.length <= 200, `downsample должен ограничивать ${data.length} точками не больше 200`);
    assert.ok(data.length > 1);
    for (let i = 1; i < data.length; i++) {
      assert.ok(data[i].rx >= data[i - 1].rx, 'после downsample порядок точек по времени должен сохраняться (rx монотонно не убывает)');
    }
    assert.ok(data[data.length - 1].rx >= N - 3, 'последняя сэмплированная точка должна быть очень близко к концу исходного ряда (downsample округляет индекс до ближайшего, не обязательно последний)');
  });

  test('GET /api/traffic/router/:routerId/:iface — история по конкретному интерфейсу роутера', async () => {
    db.prepare('DELETE FROM traffic_history').run();
    const now = Date.now();
    db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)').run('router', 'rtr1', 'ether1', now, 111, 222);
    db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)').run('router', 'rtr1', 'ether2', now, 333, 444); // другой интерфейс — не должен попасть

    const res = await api('/api/traffic/router/rtr1/ether1?range=24h');
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].rx, 111);
  });

  test('без сессии — 401 (requireAuth применён ко всем роутам traffic.js)', async () => {
    // Отдельное express-приложение без фейковой сессии, чтобы реально проверить requireAuth
    const bareApp = express();
    bareApp.use('/api/traffic', trafficRouter);
    const bareServer = await new Promise(resolve => { const s = bareApp.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const port = bareServer.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/traffic/current`);
      assert.equal(res.status, 401);
    } finally {
      bareServer.close();
    }
  });
});
