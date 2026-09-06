'use strict';
/**
 * test/unit/ldap-authenticate.test.js
 *
 * src/services/ldap.js делает `require('ldapts')` один раз при загрузке
 * модуля. Чтобы протестировать authenticate()/testConnection() без
 * реального LDAP-сервера, подменяем модуль 'ldapts' в require.cache
 * ФЕЙКОВЫМ Client ДО того, как ldap.js его потребует — стандартный трюк
 * для CommonJS-моков без сторонних библиотек мокинга.
 *
 * roleFromGroups()/escapeFilterValue() уже покрыты в pure-functions.test.js —
 * здесь фокус на связке bind→search→bind-как-пользователь и обработке ошибок.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ldaptsPath = require.resolve('ldapts');
const ldapModulePath = require.resolve('../../src/services/ldap');

// Управляемое поведение фейкового клиента — переопределяется в каждом тесте
let behavior;

class FakeClient {
  constructor(opts) { this.opts = opts; }
  async bind(dn, password) {
    if (behavior.bindShouldThrow) throw new Error(behavior.bindError || 'bind failed');
    behavior.lastBind = { dn, password };
    if (behavior.userBindRejects && behavior.userBindRejects.includes(dn)) {
      throw new Error('invalid credentials');
    }
  }
  async search(baseDN, opts) {
    behavior.lastSearch = { baseDN, ...opts };
    if (behavior.searchShouldThrow) throw new Error('search failed');
    return { searchEntries: behavior.searchEntries || [] };
  }
  async unbind() { behavior.unbindCalled = (behavior.unbindCalled || 0) + 1; }
}

function installFakeLdapts() {
  require.cache[ldaptsPath] = { id: ldaptsPath, filename: ldaptsPath, loaded: true, exports: { Client: FakeClient } };
  delete require.cache[ldapModulePath];
  return require('../../src/services/ldap');
}

describe('ldap.js: authenticate() (с фейковым ldapts.Client)', () => {
  let ldap;
  before(() => { ldap = installFakeLdapts(); });
  beforeEach(() => { behavior = {}; });
  after(() => { delete require.cache[ldaptsPath]; delete require.cache[ldapModulePath]; });

  const cfg = { url: 'ldap://dc.example.com', baseDN: 'DC=example,DC=com', bindDN: 'CN=svc,DC=example,DC=com', bindPassword: 'svc-pass' };

  test('без url/baseDN в конфиге — ok:false, "LDAP не настроен", даже не пытается подключаться', async () => {
    const res = await ldap.authenticate('jdoe', 'pass', {});
    assert.equal(res.ok, false);
    assert.equal(res.error, 'LDAP не настроен');
    assert.equal(behavior.lastBind, undefined, 'bind не должен вызываться без корректного конфига');
  });

  test('service bind (bindDN/bindPassword) падает — ok:false, соединение с сервером', async () => {
    behavior.bindShouldThrow = true;
    const res = await ldap.authenticate('jdoe', 'pass', cfg);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Ошибка соединения с LDAP-сервером');
  });

  test('поиск не находит пользователя — ok:false, "Пользователь не найден в LDAP"', async () => {
    behavior.searchEntries = [];
    const res = await ldap.authenticate('no-such-user', 'pass', cfg);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Пользователь не найден в LDAP');
  });

  test('пользователь найден, но bind с его паролем падает — ok:false, "Неверный пароль"', async () => {
    const userDN = 'CN=John Doe,OU=Users,DC=example,DC=com';
    behavior.searchEntries = [{ dn: userDN, memberOf: [], displayName: 'John Doe' }];
    behavior.userBindRejects = [userDN];
    const res = await ldap.authenticate('jdoe', 'wrong-password', cfg);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Неверный пароль');
  });

  test('успешный вход: роль по умолчанию, displayName из записи', async () => {
    const userDN = 'CN=John Doe,OU=Users,DC=example,DC=com';
    behavior.searchEntries = [{ dn: userDN, memberOf: [], displayName: 'John Doe' }];
    const res = await ldap.authenticate('jdoe', 'correct-password', { ...cfg, defaultRole: 'viewer' });
    assert.equal(res.ok, true);
    assert.equal(res.role, 'viewer');
    assert.equal(res.displayName, 'John Doe');
  });

  test('успешный вход: роль вычисляется по memberOf через roleMapping', async () => {
    const userDN = 'CN=Admin User,OU=Users,DC=example,DC=com';
    behavior.searchEntries = [{ dn: userDN, memberOf: ['CN=NetAdmins,OU=Groups,DC=example,DC=com'], cn: 'Admin User' }];
    const res = await ldap.authenticate('admin1', 'correct-password', {
      ...cfg, roleMapping: [{ group: 'CN=NetAdmins,OU=Groups,DC=example,DC=com', role: 'admin' }], defaultRole: 'viewer'
    });
    assert.equal(res.ok, true);
    assert.equal(res.role, 'admin');
    assert.equal(res.displayName, 'Admin User', 'без displayName — фоллбек на cn');
  });

  test('memberOf как одиночная строка (не массив) нормализуется перед подсчётом роли', async () => {
    const userDN = 'CN=Single Group User,DC=example,DC=com';
    behavior.searchEntries = [{ dn: userDN, memberOf: 'CN=NetAdmins,OU=Groups,DC=example,DC=com' }]; // не массив!
    const res = await ldap.authenticate('u2', 'pass', {
      ...cfg, roleMapping: [{ group: 'CN=NetAdmins,OU=Groups,DC=example,DC=com', role: 'admin' }], defaultRole: 'viewer'
    });
    assert.equal(res.ok, true);
    assert.equal(res.role, 'admin', 'одиночная строка memberOf должна обрабатываться так же, как массив из одного элемента');
  });

  test('displayName фоллбек на username, если нет ни displayName, ни cn', async () => {
    const userDN = 'CN=Bare User,DC=example,DC=com';
    behavior.searchEntries = [{ dn: userDN, memberOf: [] }];
    const res = await ldap.authenticate('bareuser', 'pass', cfg);
    assert.equal(res.displayName, 'bareuser');
  });

  test('РЕГРЕССИЯ: имя пользователя с LDAP-спецсимволами не попадает в фильтр поиска сырым текстом (экранирование от инъекции)', async () => {
    behavior.searchEntries = [];
    await ldap.authenticate('jdoe)(uid=*', 'pass', cfg);
    assert.ok(behavior.lastSearch, 'search должен был вызваться');
    assert.ok(!behavior.lastSearch.filter.includes(')(uid=*'), 'сырой спецсимвол LDAP-фильтра не должен попасть в итоговый filter — иначе это LDAP-инъекция');
    assert.match(behavior.lastSearch.filter, /\\29\\28uid=\\2a/i, 'должно быть RFC4515-экранирование ( ) * — \\28 \\29 \\2a');
  });

  test('поиск использует кастомный userFilter из конфига, если задан', async () => {
    behavior.searchEntries = [];
    await ldap.authenticate('jdoe', 'pass', { ...cfg, userFilter: '(mail={{username}})' });
    assert.match(behavior.lastSearch.filter, /^\(mail=jdoe\)$/);
  });

  test('client.unbind() вызывается даже при ошибке service bind (finally)', async () => {
    behavior.bindShouldThrow = true;
    await ldap.authenticate('jdoe', 'pass', cfg);
    assert.ok(behavior.unbindCalled >= 1, 'unbind должен вызываться в finally независимо от исхода');
  });
});

describe('ldap.js: testConnection() (с фейковым ldapts.Client)', () => {
  let ldap;
  before(() => { ldap = installFakeLdapts(); });
  beforeEach(() => { behavior = {}; });
  after(() => { delete require.cache[ldaptsPath]; delete require.cache[ldapModulePath]; });

  test('без url/bindDN — ok:false, не пытается подключаться', async () => {
    const res = await ldap.testConnection({});
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Заполните URL и Bind DN');
  });

  test('успешный bind — ok:true с сообщением', async () => {
    const res = await ldap.testConnection({ url: 'ldap://dc.example.com', bindDN: 'CN=svc,DC=example,DC=com', bindPassword: 'x' });
    assert.equal(res.ok, true);
    assert.match(res.message, /успешн/i);
  });

  test('bind падает — ok:false с текстом ошибки от сервера', async () => {
    behavior.bindShouldThrow = true;
    behavior.bindError = 'Invalid credentials (49)';
    const res = await ldap.testConnection({ url: 'ldap://dc.example.com', bindDN: 'CN=svc,DC=example,DC=com', bindPassword: 'wrong' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Invalid credentials (49)');
  });

  test('с baseDN дополнительно пробует search (ошибка search не должна ронять весь testConnection)', async () => {
    behavior.searchShouldThrow = true;
    const res = await ldap.testConnection({ url: 'ldap://dc.example.com', bindDN: 'CN=svc,DC=example,DC=com', bindPassword: 'x', baseDN: 'DC=example,DC=com' });
    assert.equal(res.ok, true, 'test connection должен остаться успешным, даже если пробный search упал (bind — главная проверка)');
  });
});
