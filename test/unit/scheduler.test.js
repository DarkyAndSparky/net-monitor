'use strict';
/**
 * test/unit/scheduler.test.js
 *
 * src/services/scheduler.js — планировщик мониторинга. pingHost() уже
 * покрыт (быстро проваливается без прав на raw ICMP — см. discovery.test.js
 * про то, почему НЕ полагаемся на успешный пинг ни в одном тесте). Здесь
 * тестируем: каналы алертов (dispatchAlert — экспортирован) через мок
 * global.fetch, пороговую логику evaluateAlert (когда алерт реально
 * отправляется — не на каждый неудачный тик), учёт инцидентов, и полный
 * прогон schedulerTick() на реальной (временной) БД.
 *
 * evaluateAlert/recordIncidentTransition/schedulerTick/trafficTick
 * экспортированы дополнительно специально для этого файла (см. комментарий
 * у module.exports в scheduler.js) — они не были доступны снаружи раньше.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDb = path.join(os.tmpdir(), `netmonitor-schedulertest-${process.pid}-${Date.now()}.db`);
process.env.NETMONITOR_DB_PATH = tmpDb;

const { db, setSetting, newId } = require('../../src/db');
const scheduler = require('../../src/services/scheduler');

// ── Мок fetch: перехватываем все исходящие HTTP-запросы алертов ────────
let fetchCalls;
const realFetch = global.fetch;
function installFakeFetch(impl) {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    if (impl) return impl(url, opts);
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

function makeDevice(overrides = {}) {
  const id = overrides.id || newId('d');
  db.prepare("INSERT OR REPLACE INTO devices (id,name,ip,category_id,check_interval,alerts_enabled) VALUES (?,?,?,?,?,?)")
    .run(id, overrides.name || 'TestDevice', overrides.ip || '10.0.0.99', 'other', overrides.check_interval || 60, overrides.alerts_enabled ?? 1);
  return { id, name: overrides.name || 'TestDevice', ip: overrides.ip || '10.0.0.99', location: '', alerts_enabled: overrides.alerts_enabled ?? 1 };
}

after(() => {
  global.fetch = realFetch;
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
});

describe('scheduler.js: dispatchAlert() — каналы уведомлений', () => {
  beforeEach(() => installFakeFetch());

  test('telegram: выключен в конфиге — fetch не вызывается', async () => {
    await scheduler.dispatchAlert({ telegram: { enabled: false } }, { id: 'd1', name: 'X' }, 'down', 'test');
    assert.equal(fetchCalls.length, 0);
  });

  test('telegram: включён — отправляет POST на api.telegram.org с botToken/chatId', async () => {
    await scheduler.dispatchAlert({ telegram: { enabled: true, botToken: 'TOKEN123', chatId: '999' } }, { id: 'd1', name: 'X' }, 'down', 'test message');
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /api\.telegram\.org\/botTOKEN123\/sendMessage/);
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body.chat_id, '999');
    assert.equal(body.text, 'test message');
  });

  test('webhook: включён с обычным URL — доставляется', async () => {
    await scheduler.dispatchAlert({ webhook: { enabled: true, url: 'https://example.com/hook' } }, { id: 'd1', name: 'X', ip: '1.2.3.4' }, 'down', 'msg');
    const call = fetchCalls.find(c => c.url === 'https://example.com/hook');
    assert.ok(call);
    const payload = JSON.parse(call.opts.body);
    assert.equal(payload.device.id, 'd1');
    assert.equal(payload.status, 'down');
  });

  test('РЕГРЕССИЯ: webhook на link-local (169.254.x.x, cloud-metadata) блокируется SSRF-guard — fetch не вызывается', async () => {
    await scheduler.dispatchAlert({ webhook: { enabled: true, url: 'http://169.254.169.254/latest/meta-data/' } }, { id: 'd1', name: 'X' }, 'down', 'msg');
    assert.equal(fetchCalls.filter(c => c.url.includes('169.254')).length, 0, 'запрос на link-local/cloud-metadata адрес не должен уйти вообще');
  });

  test('ntfy: включён — POST с правильными заголовками приоритета для "down"', async () => {
    await scheduler.dispatchAlert({ ntfy: { enabled: true, url: 'https://ntfy.sh', topic: 'netmonitor-test' } }, { id: 'd1', name: 'X' }, 'down', 'msg');
    const call = fetchCalls.find(c => c.url === 'https://ntfy.sh/netmonitor-test');
    assert.ok(call);
    assert.equal(call.opts.headers['Priority'], 'high');
    assert.equal(call.opts.headers['Tags'], 'red_circle');
  });

  test('ntfy: приоритет "default"/зелёный для "up"', async () => {
    await scheduler.dispatchAlert({ ntfy: { enabled: true, url: 'https://ntfy.sh', topic: 't' } }, { id: 'd1', name: 'X' }, 'up', 'msg');
    const call = fetchCalls.find(c => c.url.includes('ntfy.sh'));
    assert.equal(call.opts.headers['Priority'], 'default');
    assert.equal(call.opts.headers['Tags'], 'green_circle');
  });

  test('ntfy: тоже защищён SSRF-guard', async () => {
    await scheduler.dispatchAlert({ ntfy: { enabled: true, url: 'http://169.254.169.254' } }, { id: 'd1', name: 'X' }, 'down', 'msg');
    assert.equal(fetchCalls.length, 0);
  });

  test('все каналы выключены — dispatchAlert не падает и не шлёт ничего', async () => {
    await scheduler.dispatchAlert({}, { id: 'd1', name: 'X' }, 'down', 'msg');
    assert.equal(fetchCalls.length, 0);
  });
});

describe('scheduler.js: evaluateAlert() — пороговая логика (не на каждый провал)', () => {
  beforeEach(() => { installFakeFetch(); for (const k of Object.keys(scheduler.alertState)) delete scheduler.alertState[k]; });

  test('первый провал (ниже threshold) — алерт НЕ отправляется', async () => {
    setSetting('alerting', { enabled: true, failThreshold: 3, repeatMinutes: 0 });
    const device = makeDevice({ id: 'evA' });
    await scheduler.evaluateAlert(device, false);
    assert.equal(fetchCalls.length, 0, 'до достижения failThreshold алерт не должен отправляться');
  });

  test('на N-й провал (== failThreshold) — алерт отправляется ровно один раз', async () => {
    setSetting('alerting', { enabled: true, failThreshold: 3, repeatMinutes: 0, telegram: { enabled: true, botToken: 'T', chatId: 'C' } });
    const device = makeDevice({ id: 'evB' });
    await scheduler.evaluateAlert(device, false);
    await scheduler.evaluateAlert(device, false);
    assert.equal(fetchCalls.length, 0, 'ещё не достигли порога 3');
    await scheduler.evaluateAlert(device, false);
    assert.equal(fetchCalls.length, 1, 'на 3-м провале подряд должен уйти ровно один алерт');
  });

  test('дальнейшие провалы БЕЗ repeatMinutes не шлют повторных алертов', async () => {
    setSetting('alerting', { enabled: true, failThreshold: 1, repeatMinutes: 0, telegram: { enabled: true, botToken: 'T', chatId: 'C' } });
    const device = makeDevice({ id: 'evC' });
    await scheduler.evaluateAlert(device, false);
    await scheduler.evaluateAlert(device, false);
    await scheduler.evaluateAlert(device, false);
    assert.equal(fetchCalls.length, 1, 'без repeatMinutes>0 повторной отправки быть не должно');
  });

  test('device.alerts_enabled=false — evaluateAlert вообще ничего не делает', async () => {
    setSetting('alerting', { enabled: true, failThreshold: 1, telegram: { enabled: true, botToken: 'T', chatId: 'C' } });
    const device = makeDevice({ id: 'evD', alerts_enabled: 0 });
    await scheduler.evaluateAlert(device, false);
    assert.equal(fetchCalls.length, 0);
  });

  test('cfg.enabled=false (алертинг глобально выключен) — ничего не шлётся', async () => {
    setSetting('alerting', { enabled: false, failThreshold: 1, telegram: { enabled: true, botToken: 'T', chatId: 'C' } });
    const device = makeDevice({ id: 'evE' });
    await scheduler.evaluateAlert(device, false);
    assert.equal(fetchCalls.length, 0);
  });

  test('восстановление (online=true) после падения с notifyOnRecovery — шлёт "up"-алерт и сбрасывает состояние', async () => {
    setSetting('alerting', { enabled: true, failThreshold: 1, notifyOnRecovery: true, telegram: { enabled: true, botToken: 'T', chatId: 'C' } });
    const device = makeDevice({ id: 'evF' });
    await scheduler.evaluateAlert(device, false); // down-алерт (1 вызов)
    await scheduler.evaluateAlert(device, true);  // recovery
    assert.equal(fetchCalls.length, 2);
    const recoveryBody = JSON.parse(fetchCalls[1].opts.body);
    assert.match(recoveryBody.text, /снова в сети/);
    assert.equal(scheduler.alertState['evF'].consecutiveFails, 0, 'после восстановления счётчик провалов должен сброситься');
  });

  test('восстановление БЕЗ notifyOnRecovery — recovery-алерт не шлётся', async () => {
    setSetting('alerting', { enabled: true, failThreshold: 1, notifyOnRecovery: false, telegram: { enabled: true, botToken: 'T', chatId: 'C' } });
    const device = makeDevice({ id: 'evG' });
    await scheduler.evaluateAlert(device, false);
    await scheduler.evaluateAlert(device, true);
    assert.equal(fetchCalls.length, 1, 'только down-алерт, recovery подавлен настройкой');
  });
});

describe('scheduler.js: recordIncidentTransition() — учёт инцидентов', () => {
  test('при выключенной фиче incidents — ничего не пишет в таблицу incidents', () => {
    setSetting('features', { incidents: false });
    const device = makeDevice({ id: 'incA' });
    const before = db.prepare('SELECT COUNT(*) c FROM incidents').get().c;
    scheduler.recordIncidentTransition(device, true, false);
    const after = db.prepare('SELECT COUNT(*) c FROM incidents').get().c;
    assert.equal(after, before);
  });

  test('переход online→offline при включённой фиче — открывает инцидент', () => {
    setSetting('features', { incidents: true });
    const device = makeDevice({ id: 'incB' });
    scheduler.recordIncidentTransition(device, true, false);
    const inc = db.prepare('SELECT * FROM incidents WHERE device_id=? AND end_ts IS NULL').get('incB');
    assert.ok(inc, 'должна появиться открытая запись инцидента (end_ts IS NULL)');
  });

  test('переход offline→online — закрывает открытый инцидент, проставляет duration_sec', async () => {
    const device = makeDevice({ id: 'incC' });
    scheduler.recordIncidentTransition(device, true, false); // открыли
    await new Promise(r => setTimeout(r, 20));
    scheduler.recordIncidentTransition(device, false, true); // закрыли
    const inc = db.prepare('SELECT * FROM incidents WHERE device_id=? ORDER BY start_ts DESC LIMIT 1').get('incC');
    assert.ok(inc.end_ts != null);
    assert.ok(inc.duration_sec >= 0);
  });

  test('повторный online→offline без предварительного offline→online не плодит дубликат (INSERT OR IGNORE)', () => {
    const device = makeDevice({ id: 'incD' });
    scheduler.recordIncidentTransition(device, true, false);
    scheduler.recordIncidentTransition(device, false, false); // всё ещё offline, prevOnline тоже false — новый инцидент не должен открыться
    const count = db.prepare('SELECT COUNT(*) c FROM incidents WHERE device_id=?').get('incD').c;
    assert.equal(count, 1);
  });
});

describe('scheduler.js: checkDevicePorts() — реальный TCP-коннект на loopback', () => {
  let listener, listenPort;
  before(async () => {
    listener = require('node:net').createServer(socket => socket.end());
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    listenPort = listener.address().port;
  });
  after(() => listener.close());

  test('открытый порт — open:true', async () => {
    const id = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,port_checks) VALUES (?,?,?,?,?)")
      .run(id, 'PortDev', '127.0.0.1', 'other', JSON.stringify([{ port: listenPort, label: 'test-svc' }]));
    const device = { id, ip: '127.0.0.1', port_checks: JSON.stringify([{ port: listenPort, label: 'test-svc' }]) };
    await scheduler.checkDevicePorts(device);
    assert.equal(scheduler.portCheckCache[id].length, 1);
    assert.equal(scheduler.portCheckCache[id][0].open, true);
    assert.equal(scheduler.portCheckCache[id][0].label, 'test-svc');
  });

  test('закрытый порт (никто не слушает) — open:false, не падает', async () => {
    const id = newId('d');
    const device = { id, ip: '127.0.0.1', port_checks: JSON.stringify([{ port: 1, label: 'closed' }]) };
    await scheduler.checkDevicePorts(device);
    assert.equal(scheduler.portCheckCache[id][0].open, false);
  });

  test('несколько портов проверяются независимо, каждый со своим результатом', async () => {
    const id = newId('d');
    const device = { id, ip: '127.0.0.1', port_checks: JSON.stringify([{ port: listenPort, label: 'open-one' }, { port: 1, label: 'closed-one' }]) };
    await scheduler.checkDevicePorts(device);
    const results = scheduler.portCheckCache[id];
    assert.equal(results.length, 2);
    assert.equal(results.find(r => r.label === 'open-one').open, true);
    assert.equal(results.find(r => r.label === 'closed-one').open, false);
  });

  test('port_checks пустой/отсутствует — пустой результат, не падает', async () => {
    const id = newId('d');
    await scheduler.checkDevicePorts({ id, ip: '127.0.0.1', port_checks: null });
    assert.deepEqual(scheduler.portCheckCache[id], []);
  });
});

describe('scheduler.js: schedulerTick() — полный прогон на реальной БД', () => {
  beforeEach(() => installFakeFetch());

  test('непроверенное устройство (monitored=0) не опрашивается тиком', async () => {
    const id = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,monitored,check_interval) VALUES (?,?,?,?,0,?)").run(id, 'Unmonitored', '10.0.0.50', 'other', 60);
    await scheduler.schedulerTick();
    assert.equal(scheduler.statusCache[id], undefined, 'немониторимое устройство не должно попадать в statusCache');
  });

  test('мониторимое устройство опрашивается: statusCache и history обновляются', async () => {
    const id = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,monitored,check_interval,alerts_enabled) VALUES (?,?,?,?,1,?,0)").run(id, 'Monitored', '10.0.0.51', 'other', 60);
    await scheduler.schedulerTick();
    assert.ok(scheduler.statusCache[id], 'после тика должна появиться запись в statusCache');
    assert.equal(typeof scheduler.statusCache[id].online, 'boolean');
    const histCount = db.prepare('SELECT COUNT(*) c FROM history WHERE device_id=?').get(id).c;
    assert.equal(histCount, 1, 'тик должен записать ровно одну строку в history');
  });

  test('повторный тик СРАЗУ ЖЕ (в пределах check_interval) не переопрашивает устройство повторно', async () => {
    const id = newId('d');
    db.prepare("INSERT INTO devices (id,name,ip,category_id,monitored,check_interval,alerts_enabled) VALUES (?,?,?,?,1,?,0)").run(id, 'Monitored2', '10.0.0.52', 'other', 3600);
    await scheduler.schedulerTick();
    await scheduler.schedulerTick();
    const histCount = db.prepare('SELECT COUNT(*) c FROM history WHERE device_id=?').get(id).c;
    assert.equal(histCount, 1, 'в пределах check_interval повторный тик должен быть no-op для этого устройства');
  });
});
