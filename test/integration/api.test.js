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

  after(async () => {
    // SIGKILL не даёт V8 сбросить данные покрытия на диск (см. то же в auth.test.js) —
    // SIGTERM + ожидание exit позволяет c8 увидеть реальное покрытие этого процесса.
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

  test('РЕГРЕССИЯ: escalation в alert-settings сохраняется и не сбрасывается повторным сохранением', async () => {
    // Первое сохранение: включаем эскалацию явно
    await api('/api/alert-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, escalation: { enabled: true, afterMinutes: 90, telegramChatId: '-100999' } })
    });
    let cfg = await api('/api/alert-settings').then(r => r.json());
    assert.equal(cfg.escalation.enabled, true, 'эскалация должна включиться');
    assert.equal(cfg.escalation.afterMinutes, 90);
    assert.equal(cfg.escalation.telegramChatId, '-100999');

    // Второе сохранение БЕЗ ключа escalation вообще (имитация старого сломанного фронта,
    // который никогда не отправлял эти поля) — значения должны сохраниться через prev-фоллбэк,
    // а не молча сброситься в false/60/''
    await api('/api/alert-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, telegram: { enabled: false, chatId: '', botToken: '' } })
    });
    cfg = await api('/api/alert-settings').then(r => r.json());
    assert.equal(cfg.escalation.enabled, true, 'эскалация не должна тихо выключаться при сохранении формы без этого поля');
    assert.equal(cfg.escalation.afterMinutes, 90, 'afterMinutes не должен сбрасываться на дефолт');
    assert.equal(cfg.escalation.telegramChatId, '-100999', 'telegramChatId не должен теряться');
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

  test('логи: /api/logs отвечает текущими записями', async () => {
    const res = await api('/api/logs?lines=50');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.lines));
    assert.ok('date' in data);
    assert.ok('count' in data);
  });

  test('логи: /api/logs/files отвечает списком архивных файлов', async () => {
    const res = await api('/api/logs/files');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.files));
  });

  test('логи: нельзя удалить текущий активный файл', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await api(`/api/logs/file/${today}`, { method: 'DELETE' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'cannot_delete_current');
  });

  test('логи: удаление несуществующей даты отвечает 404', async () => {
    const res = await api('/api/logs/file/2020-01-01', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('логи: неавторизованный запрос к /api/logs отклоняется', async () => {
    const prevCookie = sessionCookie;
    sessionCookie = '';
    const res = await api('/api/logs');
    assert.equal(res.status, 401);
    sessionCookie = prevCookie;
  });

  test('РЕГРЕССИЯ: бэкап-restore не теряет sites/site_id/snmp.ifIndex/ldap/eventWebhook', async () => {
    // Готовим полный набор данных, который раньше молча терялся при restore.
    // Добавляем к уже существующим площадкам (более ранний тест создал свою
    // и привязал к ней устройство) — полная замена списка тут провалилась бы.
    const existingSites = await api('/api/sites').then(r => r.json());
    await api('/api/sites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sites: [...existingSites, { name: 'Резервная площадка', color: '#3b82f6', address: 'ул. Тестовая 1' }] })
    });
    const sites = await api('/api/sites').then(r => r.json());
    const siteId = sites.find(s => s.name === 'Резервная площадка').id;

    await api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'BackupRoundTripDevice', ip: '10.0.0.88', site: siteId, monitored: false, snmp: { enabled: true, community: 'public', port: 161, ifIndex: 7 } })
    });
    await api('/api/ldap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, url: 'ldap://roundtrip.test', bindDN: 'cn=svc,dc=test' })
    });
    await api('/api/event-webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, url: 'https://roundtrip.example.com/hook' })
    });

    const bundle = await api('/api/backup').then(r => r.json());
    assert.ok(bundle.devices.sites.some(s => s.name === 'Резервная площадка'), 'sites должны быть в экспорте');
    assert.equal(bundle.settings.ldap.enabled, true, 'ldap-настройки должны быть в экспорте');
    assert.equal(bundle.settings.eventWebhook.enabled, true, 'eventWebhook-настройки должны быть в экспорте');

    const restoreRes = await api('/api/backup/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    assert.equal(restoreRes.status, 200);

    const sitesAfter = await api('/api/sites').then(r => r.json());
    assert.ok(sitesAfter.some(s => s.name === 'Резервная площадка'), 'площадка должна пережить restore');

    const devicesAfter = await api('/api/devices').then(r => r.json());
    const deviceAfter = devicesAfter.find(d => d.name === 'BackupRoundTripDevice');
    assert.ok(deviceAfter, 'устройство должно пережить restore');
    assert.equal(deviceAfter.site, siteId, 'привязка к площадке должна пережить restore');
    assert.equal(deviceAfter.snmp.ifIndex, 7, 'snmp.ifIndex должен пережить restore');

    const ldapAfter = await api('/api/ldap').then(r => r.json());
    assert.equal(ldapAfter.enabled, true, 'ldap-настройки должны пережить restore');
    assert.equal(ldapAfter.url, 'ldap://roundtrip.test');

    const ewAfter = await api('/api/event-webhook').then(r => r.json());
    assert.equal(ewAfter.enabled, true, 'eventWebhook-настройки должны пережить restore');
    assert.equal(ewAfter.url, 'https://roundtrip.example.com/hook');
  });

  test('категории: полный цикл создания и защита от удаления используемой', async () => {
    const before = await api('/api/categories').then(r => r.json());
    const newSet = [...before, { name: 'Тестовая категория', color: '#ff0000' }];
    const created = await api('/api/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: newSet })
    }).then(r => r.json());
    const testCat = created.find(c => c.name === 'Тестовая категория');
    assert.ok(testCat, 'новая категория должна создаться');

    await api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CategoryTestDevice', ip: '10.0.0.89', category: testCat.id, monitored: false })
    });

    // Пытаемся удалить категорию, которая теперь используется устройством
    const withoutTestCat = created.filter(c => c.id !== testCat.id);
    const res = await api('/api/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: withoutTestCat })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'category_in_use');
  });

  test('пользователи: создание оператора, смена роли, удаление', async () => {
    const createRes = await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testoperator', password: 'OperatorPass123456', role: 'operator' })
    });
    assert.equal(createRes.status, 200);

    const users = await api('/api/users').then(r => r.json());
    const created = users.find(u => u.username === 'testoperator');
    assert.ok(created);
    assert.equal(created.role, 'operator');
    assert.equal(created.source, 'local');

    const roleRes = await api(`/api/users/testoperator/role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' })
    });
    assert.equal(roleRes.status, 200);
    const usersAfterRole = await api('/api/users').then(r => r.json());
    assert.equal(usersAfterRole.find(u => u.username === 'testoperator').role, 'viewer');

    const delRes = await api('/api/users/testoperator', { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const usersAfterDelete = await api('/api/users').then(r => r.json());
    assert.ok(!usersAfterDelete.some(u => u.username === 'testoperator'));
  });

  test('нельзя удалить последнего администратора', async () => {
    const res = await api('/api/users/admin', { method: 'DELETE' });
    assert.equal(res.status, 400);
  });

  test('устройства: CSV-импорт создаёт устройства из строк', async () => {
    const csv = 'name,ip,category\nCSVDevice1,10.0.0.91,other\nCSVDevice2,10.0.0.92,other\n';
    const res = await api('/api/devices/import-csv', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv })
    });
    assert.equal(res.status, 200);
    const devices = await api('/api/devices').then(r => r.json());
    assert.ok(devices.some(d => d.name === 'CSVDevice1'));
    assert.ok(devices.some(d => d.name === 'CSVDevice2'));
  });
});
