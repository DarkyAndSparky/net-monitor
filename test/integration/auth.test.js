'use strict';
/**
 * test/integration/auth.test.js
 *
 * src/routes/auth.js — самый чувствительный файл в проекте (timingPad,
 * lockout по IP, LDAP-фоллбек, принудительная смена пароля) — до этого
 * теста имел 0% покрытия. Поднимает отдельный экземпляр реального
 * server.js на своей временной БД (как test/integration/api.test.js),
 * чтобы не пересекаться с его состоянием.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 19800 + (process.pid % 500); // отдельный диапазон портов от api.test.js
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `netmonitor-authtest-${process.pid}-${Date.now()}.db`);

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

function withoutSession(fn) {
  return async (...args) => {
    const prev = sessionCookie;
    sessionCookie = '';
    try { return await fn(...args); } finally { sessionCookie = prev; }
  };
}

describe('NetMonitor Auth API (логин, lockout, смена пароля, пользователи)', () => {
  before(async () => {
    serverProcess = spawn('node', [path.join(__dirname, '../../server.js')], {
      env: {
        ...process.env,
        NETMONITOR_DB_PATH: tmpDb,
        HTTP_REDIRECT_PORT: String(PORT),
        NO_BROWSER: '1',
        PORT: '0',
        RATE_LIMIT_DISABLED: 'true' // тестируем lockout auth.js, а не express-rate-limit (см. rate-limit.test.js)
      },
      stdio: 'pipe'
    });
    await waitForServer();
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin0000' }) });
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin0000', newPassword: 'AdminPass123456' }) });
  });

  after(async () => {
    // SIGKILL не даёт V8 сбросить данные покрытия на диск (нет шанса выполнить
    // atExit-хук) — при c8/NODE_V8_COVERAGE это молча теряет coverage всего
    // дочернего процесса. SIGTERM даёт процессу шанс завершиться штатно.
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

  test('несуществующий username отклоняется как invalid_credentials (timingPad-ветка)', withoutSession(async () => {
    const res = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'no-such-user', password: 'whatever123' }) });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'invalid_credentials');
  }));

  test('username не строка (число/массив) отклоняется без падения сервера', withoutSession(async () => {
    const res = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 12345, password: 'x' }) });
    assert.equal(res.status, 401);
  }));

  test('/api/me без сессии отвечает 401 auth_required', withoutSession(async () => {
    const res = await api('/api/me');
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'auth_required');
  }));

  test('/api/me с валидной сессией возвращает username и роль', async () => {
    const res = await api('/api/me');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.username, 'admin');
    assert.equal(data.role, 'admin');
    assert.equal(data.mustChangePassword, false);
  });

  test('change-password: слишком короткий новый пароль отклоняется', async () => {
    const res = await api('/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'AdminPass123456', newPassword: 'short' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'weak_password');
  });

  test('change-password: неверный текущий пароль отклоняется', async () => {
    const res = await api('/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'totally-wrong', newPassword: 'NewValidPass123456' })
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'wrong_current_password');
  });

  test('change-password: новый пароль совпадает со старым — отклоняется', async () => {
    const res = await api('/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'AdminPass123456', newPassword: 'AdminPass123456' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'same_password');
  });

  test('users: невалидный username (спецсимволы/слишком короткий) отклоняется', async () => {
    const res = await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a b!', password: 'ValidPass123456', role: 'viewer' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'invalid_username');
  });

  test('users: дубликат username отклоняется 409', async () => {
    await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dupeuser', password: 'ValidPass123456', role: 'viewer' })
    });
    const res = await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dupeuser', password: 'AnotherPass123456', role: 'viewer' })
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.error, 'already_exists');
  });

  test('users: неизвестная роль в теле запроса тихо становится viewer (normalizeRole)', async () => {
    await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'weirdroleuser', password: 'ValidPass123456', role: 'superadmin' })
    });
    const users = await api('/api/users').then(r => r.json());
    const created = users.find(u => u.username === 'weirdroleuser');
    assert.ok(created);
    assert.equal(created.role, 'viewer', 'невалидная роль в запросе должна фоллбечиться на viewer, не приниматься как есть');
  });

  test('РЕГРЕССИЯ: нельзя понизить в роли последнего администратора', async () => {
    // admin сейчас единственный админ (weirdroleuser/dupeuser — viewer)
    const res = await api('/api/users/admin/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'last_admin');

    const me = await api('/api/me').then(r => r.json());
    assert.equal(me.role, 'admin', 'роль последнего админа не должна была измениться');
  });

  test('можно понизить админа, если есть второй администратор', async () => {
    await api('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'secondadmin', password: 'ValidPass123456', role: 'admin' })
    });
    const res = await api('/api/users/secondadmin/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' })
    });
    assert.equal(res.status, 200);
    const users = await api('/api/users').then(r => r.json());
    assert.equal(users.find(u => u.username === 'secondadmin').role, 'viewer');
  });

  test('нельзя удалить самого себя', async () => {
    const res = await api('/api/users/admin', { method: 'DELETE' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'cannot_delete_self');
  });

  test('удаление несуществующего пользователя — 404', async () => {
    const res = await api('/api/users/no-such-user-at-all', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('изменение роли несуществующего пользователя — 404', async () => {
    const res = await api('/api/users/no-such-user-at-all/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' })
    });
    assert.equal(res.status, 404);
  });

  test('/api/users доступен только admin (requireAdmin)', async () => {
    // Логинимся под ранее созданным viewer-пользователем
    const prevCookie = sessionCookie;
    sessionCookie = '';
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dupeuser', password: 'ValidPass123456' }) });
    // Без смены пароля любой роут отвечает 403 password_change_required, что
    // маскирует именно ролевую проверку ниже.
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'ValidPass123456', newPassword: 'ValidPass2ndRound123456' }) });
    const res = await api('/api/users');
    assert.equal(res.status, 403, 'viewer не должен иметь доступ к списку пользователей');
    assert.equal((await res.json()).error, 'forbidden', 'должно быть именно forbidden (нехватка роли), а не password_change_required');
    sessionCookie = prevCookie;
  });

  test('logout уничтожает сессию — последующий запрос требует логина заново', async () => {
    const prevCookie = sessionCookie;
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'AdminPass123456' }) });
    const logoutRes = await api('/api/logout', { method: 'POST' });
    assert.equal(logoutRes.status, 200);
    const me = await api('/api/me');
    assert.equal(me.status, 401, 'после logout сессия должна быть недействительна');
    sessionCookie = prevCookie;
  });

  // ВАЖНО: этот тест должен идти последним в файле — lockout реальный (по времени,
  // не сбрасывается RATE_LIMIT_DISABLED), и залочит IP теста на LOGIN_LOCKOUT_MS
  // (5 минут), сломав любой следующий тест, которому нужен свежий /api/login с нуля.
  test('РЕГРЕССИЯ: lockout после 5 неудачных попыток с одного IP — 429 too_many_attempts', withoutSession(async () => {
    for (let i = 0; i < 5; i++) {
      const res = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-pass' }) });
      assert.equal(res.status, 401, `попытка ${i + 1} должна быть 401, не lockout ещё`);
    }
    const locked = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-pass' }) });
    assert.equal(locked.status, 429);
    const data = await locked.json();
    assert.equal(data.error, 'too_many_attempts');

    // Даже с ПРАВИЛЬНЫМ паролем — залоченный IP не должен пройти, пока не истечёт lockout
    const lockedEvenCorrect = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'AdminPass123456' }) });
    assert.equal(lockedEvenCorrect.status, 429, 'lockout должен блокировать даже верный пароль, пока не истечёт LOGIN_LOCKOUT_MS');
  }));
});
