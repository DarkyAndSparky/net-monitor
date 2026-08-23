'use strict';
/**
 * test/unit/pure-functions.test.js
 *
 * Тесты чистых функций, не требующих БД или сети: slugify, csvCell,
 * hashPassword/verifyPassword, parseCsvLine, escapeFilterValue, roleFromGroups.
 * Запуск: npm test (или node --test test/)
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Изолируем от реальной БД проекта: указываем временный файл ДО первого require('../db')
const tmpDb = path.join(os.tmpdir(), `netmonitor-test-${process.pid}-${Date.now()}.db`);
process.env.NETMONITOR_DB_PATH = tmpDb;

const { slugify, csvCell, hashPassword, verifyPassword } = require('../../src/db');
const { parseCsvLine } = require('../../src/routes/devices');
const { escapeFilterValue, roleFromGroups } = require('../../src/services/ldap');

describe('slugify', () => {
  test('транслитерирует пробелы и спецсимволы в дефисы', () => {
    const s = slugify('Сетевое оборудование!');
    assert.match(s, /^[a-zа-я0-9-]+$/i);
    assert.ok(!s.includes(' '), 'не должно содержать пробелов');
  });

  test('никогда не пустой результат даже для пустой строки', () => {
    assert.ok(slugify('').length > 0);
  });

  test('два вызова с одинаковым именем дают разные id (защита от коллизий)', () => {
    const a = slugify('Москва');
    const b = slugify('Москва');
    assert.notEqual(a, b, 'случайный суффикс должен различаться');
  });
});

describe('csvCell (защита от CSV-инъекций)', () => {
  test('экранирует формулы, начинающиеся с =, +, -, @', () => {
    assert.equal(csvCell('=cmd|calc'), `"'=cmd|calc"`);
    assert.equal(csvCell('+1+1'), `"'+1+1"`);
    assert.equal(csvCell('-1-1'), `"'-1-1"`);
    assert.equal(csvCell('@SUM(1,1)'), `"'@SUM(1,1)"`);
  });

  test('обычный текст не экранируется лишним апострофом', () => {
    assert.equal(csvCell('Router1'), '"Router1"');
  });

  test('экранирует внутренние кавычки удвоением', () => {
    assert.equal(csvCell('Роутер "главный"'), '"Роутер ""главный"""');
  });
});

describe('hashPassword / verifyPassword', () => {
  test('верный пароль проходит проверку', () => {
    const { salt, hash } = hashPassword('MySecurePass123');
    assert.equal(verifyPassword('MySecurePass123', salt, hash), true);
  });

  test('неверный пароль не проходит проверку', () => {
    const { salt, hash } = hashPassword('MySecurePass123');
    assert.equal(verifyPassword('WrongPassword', salt, hash), false);
  });

  test('два хэша одного пароля различаются (уникальная соль)', () => {
    const a = hashPassword('SamePassword1');
    const b = hashPassword('SamePassword1');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
  });
});

describe('parseCsvLine (импорт устройств из CSV)', () => {
  test('разбирает простую строку без кавычек', () => {
    assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  });

  test('разбирает поле в кавычках, содержащее запятую', () => {
    assert.deepEqual(parseCsvLine('Router1,"Москва, офис",10.0.0.1'), ['Router1', 'Москва, офис', '10.0.0.1']);
  });

  test('разбирает экранированные кавычки внутри поля ("")', () => {
    assert.deepEqual(parseCsvLine('a,"он сказал ""привет""",c'), ['a', 'он сказал "привет"', 'c']);
  });

  test('корректно обрабатывает пустые поля', () => {
    assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);
  });
});

describe('LDAP: escapeFilterValue (защита от LDAP-инъекций, RFC 4515)', () => {
  test('экранирует спецсимволы фильтра', () => {
    const result = escapeFilterValue('admin)(uid=*');
    assert.ok(!result.includes(')('), 'закрывающая-открывающая скобка не должна остаться как есть');
    assert.match(result, /\\29/); // ')' -> \29
    assert.match(result, /\\28/); // '(' -> \28
    assert.match(result, /\\2a/); // '*' -> \2a
  });

  test('обычные имена пользователей не изменяются', () => {
    assert.equal(escapeFilterValue('ivanov.i'), 'ivanov.i');
    assert.equal(escapeFilterValue('petrov_p'), 'petrov_p');
  });
});

describe('LDAP: roleFromGroups (маппинг ролей по группам AD)', () => {
  const mapping = [
    { group: 'CN=NetAdmins,OU=Groups,DC=example,DC=com', role: 'admin' },
    { group: 'CN=NetOperators,OU=Groups,DC=example,DC=com', role: 'operator' }
  ];

  test('находит роль по точному совпадению группы, регистронезависимо', () => {
    assert.equal(roleFromGroups(['cn=netadmins,ou=groups,dc=example,dc=com'], mapping, 'viewer'), 'admin');
  });

  test('возвращает роль по умолчанию, если группа не совпала', () => {
    assert.equal(roleFromGroups(['CN=SomeOtherGroup,DC=example,DC=com'], mapping, 'viewer'), 'viewer');
  });

  test('при нескольких группах побеждает первое совпавшее правило по порядку списка', () => {
    const groups = ['CN=NetOperators,OU=Groups,DC=example,DC=com', 'CN=NetAdmins,OU=Groups,DC=example,DC=com'];
    assert.equal(roleFromGroups(groups, mapping, 'viewer'), 'admin');
  });

  test('пустой список групп даёт роль по умолчанию', () => {
    assert.equal(roleFromGroups([], mapping, 'viewer'), 'viewer');
  });
});

describe('logs.parseLine (разбор строк pino-лога)', () => {
  const { parseLine } = require('../../src/routes/logs');

  test('разбирает валидную JSON-строку pino и переводит числовой level в текстовый', () => {
    const line = JSON.stringify({ level: 30, time: '2026-08-22T10:00:00.000Z', pid: 123, msg: 'Сервер запущен' });
    const parsed = parseLine(line);
    assert.equal(parsed.level, 'INFO');
    assert.equal(parsed.msg, 'Сервер запущен');
    assert.equal(parsed.ts, Date.parse('2026-08-22T10:00:00.000Z'));
  });

  test('переводит все стандартные уровни pino корректно', () => {
    const levels = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
    for (const [num, name] of Object.entries(levels)) {
      const parsed = parseLine(JSON.stringify({ level: Number(num), msg: 'x' }));
      assert.equal(parsed.level, name, `level ${num} должен переводиться в ${name}`);
    }
  });

  test('сохраняет дополнительные поля (method, url, status) отдельно от служебных', () => {
    const line = JSON.stringify({ level: 30, time: '2026-08-22T10:00:00.000Z', pid: 1, hostname: 'h', v: 1, msg: 'HTTP', method: 'GET', url: '/devices', status: 200 });
    const parsed = parseLine(line);
    assert.equal(parsed.method, 'GET');
    assert.equal(parsed.url, '/devices');
    assert.equal(parsed.status, 200);
    // служебные поля pid/hostname/v не должны просачиваться как "дополнительные"
    assert.equal('pid' in parsed, false);
    assert.equal('hostname' in parsed, false);
    assert.equal('v' in parsed, false);
  });

  test('невалидный JSON не роняет парсер — возвращается как RAW с исходным текстом', () => {
    const parsed = parseLine('это не JSON, а обычный текст из stdout стороннего процесса');
    assert.equal(parsed.level, 'RAW');
    assert.equal(parsed.msg, 'это не JSON, а обычный текст из stdout стороннего процесса');
    assert.equal(parsed.ts, null);
  });

  test('JSON-массив или примитив (не объект) тоже трактуется как RAW', () => {
    const parsed = parseLine('[1,2,3]');
    assert.equal(parsed.level, 'RAW');
  });

  test('неизвестный числовой level не роняет парсер, даёт RAW', () => {
    const parsed = parseLine(JSON.stringify({ level: 999, msg: 'странный уровень' }));
    assert.equal(parsed.level, 'RAW');
  });
});
