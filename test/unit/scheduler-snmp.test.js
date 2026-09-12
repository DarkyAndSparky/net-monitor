'use strict';
/**
 * test/unit/scheduler-snmp.test.js
 *
 * Последний непокрытый кусок scheduler.js: pollSnmp()/pollDeviceTraffic()/
 * pollRouterTraffic() (через trafficTick()). Оба используют реальные
 * протоколы (SNMP, RouterOS API), недоступные в этой песочнице — как и с
 * ldapts в ldap-authenticate.test.js, подменяем зависимости в require.cache
 * ДО того, как scheduler.js их потребует:
 *  - 'net-snmp' → фейковая createSession()/isVarbindError()
 *  - '../routes/integrations' → фейковый routerOsQuery() (единственное, что
 *    реально нужно scheduler.js от этого модуля — он не поднимает Express)
 *
 * ВАЖНО: scheduler.js — синглтон с side-effect при require() (сразу же
 * стартует setInterval(schedulerTick) и один тик schedulerTick() вживую).
 * Поэтому этот файл держит СВОЙ собственный fresh require scheduler.js
 * (с уже подменёнными net-snmp/integrations) и не полагается на кеш,
 * который могли создать другие тестовые файлы.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDb = path.join(os.tmpdir(), `netmonitor-schedulersnmptest-${process.pid}-${Date.now()}.db`);
process.env.NETMONITOR_DB_PATH = tmpDb;

// ── Фейковый net-snmp ────────────────────────────────────────────────
let snmpBehavior = {};
const netSnmpPath = require.resolve('net-snmp');
const fakeNetSnmp = {
  createSession(ip, community, opts) {
    snmpBehavior.lastSession = { ip, community, opts };
    return {
      get(oids, cb) {
        snmpBehavior.lastOids = oids;
        if (snmpBehavior.errorOnGet) return cb(new Error('SNMP timeout'));
        const values = snmpBehavior.values || oids.map(() => ({ value: 0 }));
        cb(null, values);
      },
      close() { snmpBehavior.closed = (snmpBehavior.closed || 0) + 1; }
    };
  },
  isVarbindError(vb) { return !!(vb && vb.isError); }
};

// ── Фейковый '../routes/integrations' (только routerOsQuery нужен) ────
let routerOsBehavior = {};
const integrationsPath = require.resolve('../../src/routes/integrations');
const fakeIntegrations = (() => {
  const fn = () => {}; // роутер scheduler.js не использует, достаточно функции-заглушки
  fn.routerOsQuery = async (cfg, command) => {
    routerOsBehavior.lastCall = { cfg, command };
    if (routerOsBehavior.shouldThrow) throw new Error('router unreachable');
    return routerOsBehavior.result || [];
  };
  return fn;
})();

require.cache[netSnmpPath] = { id: netSnmpPath, filename: netSnmpPath, loaded: true, exports: fakeNetSnmp };
require.cache[integrationsPath] = { id: integrationsPath, filename: integrationsPath, loaded: true, exports: fakeIntegrations };
delete require.cache[require.resolve('../../src/services/scheduler')];

const { db, setSetting, newId } = require('../../src/db');
const scheduler = require('../../src/services/scheduler');

after(() => {
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
});

function makeSnmpDevice(overrides = {}) {
  const id = overrides.id || newId('d');
  db.prepare(`INSERT INTO devices (id,name,ip,category_id,monitored,check_interval,alerts_enabled,snmp_enabled,snmp_community,snmp_port,snmp_if_index)
              VALUES (?,?,?,?,1,60,0,1,?,?,?)`)
    .run(id, overrides.name || 'SnmpDevice', overrides.ip || '10.0.0.77', 'other',
         overrides.community || 'public', overrides.port || 161, overrides.ifIndex ?? null);
  return db.prepare('SELECT * FROM devices WHERE id=?').get(id);
}

describe('scheduler.js: pollSnmp() через schedulerTick() (фейковый net-snmp)', () => {
  beforeEach(() => { snmpBehavior = {}; setSetting('features', { snmp: true }); });

  test('успешный SNMP-опрос заполняет snmpCache с sysUptime/cpuLoad', async () => {
    snmpBehavior.values = [{ value: 123456 }, { value: 42 }];
    makeSnmpDevice({ id: 'snmpA' });
    await scheduler.schedulerTick();
    const cached = scheduler.snmpCache['snmpA'];
    assert.ok(cached, 'после тика должна появиться запись в snmpCache для устройства с snmp_enabled=1');
    assert.equal(cached.error, null);
    assert.equal(cached.sysUptimeTicks, 123456);
    assert.equal(cached.cpuLoad, 42);
  });

  test('сессия открывается с правильными community/port устройства', async () => {
    snmpBehavior.values = [{ value: 1 }, { value: 1 }];
    makeSnmpDevice({ id: 'snmpB', community: 'my-secret-community', port: 1161 });
    await scheduler.schedulerTick();
    assert.equal(snmpBehavior.lastSession.community, 'my-secret-community');
    assert.equal(snmpBehavior.lastSession.opts.port, 1161);
  });

  test('ошибка SNMP (таймаут) — snmpCache отражает ошибку, не падает', async () => {
    snmpBehavior.errorOnGet = true;
    makeSnmpDevice({ id: 'snmpC' });
    await scheduler.schedulerTick();
    assert.equal(scheduler.snmpCache['snmpC'].error, 'Нет ответа по SNMP');
  });

  test('varbind-ошибка на одном OID из двух — значение для него null, второй читается нормально', async () => {
    snmpBehavior.values = [{ isError: true }, { value: 77 }];
    makeSnmpDevice({ id: 'snmpD' });
    await scheduler.schedulerTick();
    const cached = scheduler.snmpCache['snmpD'];
    assert.equal(cached.sysUptimeTicks, null);
    assert.equal(cached.cpuLoad, 77);
  });

  test('session.close() вызывается после опроса (не течёт)', async () => {
    snmpBehavior.values = [{ value: 1 }, { value: 1 }];
    makeSnmpDevice({ id: 'snmpE' });
    await scheduler.schedulerTick();
    assert.ok(snmpBehavior.closed >= 1);
  });

  test('features.snmp=false — SNMP не опрашивается вообще, даже если у устройства snmp_enabled=1', async () => {
    setSetting('features', { snmp: false });
    snmpBehavior.values = [{ value: 1 }, { value: 1 }];
    makeSnmpDevice({ id: 'snmpF' });
    await scheduler.schedulerTick();
    assert.equal(scheduler.snmpCache['snmpF'], undefined);
  });
});

describe('scheduler.js: pollDeviceTraffic()/trafficTick() (фейковый net-snmp, дельта bps)', () => {
  beforeEach(() => {
    snmpBehavior = {};
    setSetting('features', { traffic: true });
    db.prepare('DELETE FROM traffic_history').run();
    db.prepare('DELETE FROM devices').run(); // иначе устройства из прошлых тестов этого блока тоже попадают под опрос
  });

  test('первый опрос только запоминает базовую точку — traffic_history не пишется', async () => {
    snmpBehavior.values = [{ value: 1000 }, { value: 500 }];
    makeSnmpDevice({ id: 'trA', ifIndex: 1 });
    await scheduler.trafficTick();
    const count = db.prepare('SELECT COUNT(*) c FROM traffic_history').get().c;
    assert.equal(count, 0, 'без предыдущей точки посчитать дельту-bps нельзя — первый опрос только калибровка');
  });

  test('второй опрос считает дельту в bps и пишет в traffic_history', async () => {
    makeSnmpDevice({ id: 'trB', ifIndex: 1 });
    snmpBehavior.values = [{ value: 1000 }, { value: 500 }];
    await scheduler.trafficTick(); // калибровка

    // Ждём хотя бы 1 секунду реального времени — pollDeviceTraffic отбрасывает
    // интервалы короче 1с (elapsedSec < 1 → return), это не мок-параметр, а
    // реальная защита в коде от деления на около-нулевой промежуток времени.
    await new Promise(r => setTimeout(r, 1100));
    snmpBehavior.values = [{ value: 9000 }, { value: 4500 }]; // +8000 rx байт, +4000 tx байт за ~1.1с
    await scheduler.trafficTick();

    const row = db.prepare("SELECT * FROM traffic_history WHERE source_type='device' AND source_id='trB'").get();
    assert.ok(row, 'вторая точка должна попасть в traffic_history');
    assert.ok(row.rx_bps > 0 && row.tx_bps > 0);
    // 8000 байт * 8 бит / ~1.1с ≈ 58000 бит/с — проверяем порядок величины, не точное число (реальное время не детерминировано)
    assert.ok(row.rx_bps > 20000 && row.rx_bps < 100000, `rx_bps=${row.rx_bps} должен быть в разумных пределах для 8000 байт за ~1.1с`);
  });

  test('устройство без snmp_if_index не опрашивается по трафику вообще', async () => {
    makeSnmpDevice({ id: 'trC', ifIndex: null });
    snmpBehavior.values = [{ value: 1000 }, { value: 500 }];
    await scheduler.trafficTick();
    assert.equal(snmpBehavior.lastSession, undefined, 'без snmp_if_index snmpGetIfOctets не должен даже открывать SNMP-сессию');
  });

  test('features.traffic=false — трафик не опрашивается вообще', async () => {
    setSetting('features', { traffic: false });
    makeSnmpDevice({ id: 'trD', ifIndex: 1 });
    snmpBehavior.values = [{ value: 1000 }, { value: 500 }];
    await scheduler.trafficTick();
    assert.equal(snmpBehavior.lastSession, undefined);
  });

  test('счётчик "перевернулся" (текущее значение меньше предыдущего) — считается как новое значение, не отрицательная дельта', async () => {
    makeSnmpDevice({ id: 'trE', ifIndex: 1 });
    snmpBehavior.values = [{ value: 4294960000 }, { value: 100 }]; // около границы 32-битного счётчика
    await scheduler.trafficTick();
    await new Promise(r => setTimeout(r, 1100));
    snmpBehavior.values = [{ value: 500 }, { value: 50 }]; // meньше предыдущего — wrap-around
    await scheduler.trafficTick();
    const row = db.prepare("SELECT * FROM traffic_history WHERE source_type='device' AND source_id='trE'").get();
    assert.ok(row.rx_bps >= 0, 'после wrap-around bps не должен быть отрицательным');
  });
});

describe('scheduler.js: pollRouterTraffic() (фейковый routerOsQuery)', () => {
  beforeEach(() => { routerOsBehavior = {}; setSetting('features', { traffic: true }); db.prepare('DELETE FROM traffic_history').run(); });

  test('роутер без trafficInterfaces в конфиге — routerOsQuery не вызывается', async () => {
    setSetting('mikrotiks', [{ id: 'rtrA', name: 'R1', host: '10.0.0.1', trafficInterfaces: [] }]);
    await scheduler.trafficTick();
    assert.equal(routerOsBehavior.lastCall, undefined);
  });

  test('роутер недоступен (routerOsQuery падает) — trafficTick не падает целиком', async () => {
    routerOsBehavior.shouldThrow = true;
    setSetting('mikrotiks', [{ id: 'rtrB', name: 'R2', host: '10.0.0.2', trafficInterfaces: ['ether1'] }]);
    await assert.doesNotReject(scheduler.trafficTick());
  });

  test('первый опрос интерфейса — только калибровка, второй — считает дельту и пишет в traffic_history', async () => {
    setSetting('mikrotiks', [{ id: 'rtrC', name: 'R3', host: '10.0.0.3', trafficInterfaces: ['ether1'] }]);
    routerOsBehavior.result = [{ name: 'ether1', 'rx-byte': '2000', 'tx-byte': '1000' }];
    await scheduler.trafficTick();
    let count = db.prepare('SELECT COUNT(*) c FROM traffic_history').get().c;
    assert.equal(count, 0);

    await new Promise(r => setTimeout(r, 1100));
    routerOsBehavior.result = [{ name: 'ether1', 'rx-byte': '10000', 'tx-byte': '5000' }];
    await scheduler.trafficTick();

    const row = db.prepare("SELECT * FROM traffic_history WHERE source_type='router' AND source_id='rtrC' AND iface='ether1'").get();
    assert.ok(row);
    assert.ok(row.rx_bps > 0);
  });

  test('интерфейс, отсутствующий в ответе роутера, тихо пропускается', async () => {
    setSetting('mikrotiks', [{ id: 'rtrD', name: 'R4', host: '10.0.0.4', trafficInterfaces: ['ether99-does-not-exist'] }]);
    routerOsBehavior.result = [{ name: 'ether1', 'rx-byte': '100', 'tx-byte': '100' }];
    await assert.doesNotReject(scheduler.trafficTick());
    const count = db.prepare('SELECT COUNT(*) c FROM traffic_history').get().c;
    assert.equal(count, 0);
  });

  test('запрос уходит именно на /interface/print', async () => {
    setSetting('mikrotiks', [{ id: 'rtrE', name: 'R5', host: '10.0.0.5', trafficInterfaces: ['ether1'] }]);
    routerOsBehavior.result = [];
    await scheduler.trafficTick();
    assert.equal(routerOsBehavior.lastCall.command, '/interface/print');
  });
});
