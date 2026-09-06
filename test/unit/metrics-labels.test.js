'use strict';
/**
 * test/unit/metrics-labels.test.js
 *
 * Прямой юнит-тест функции labels() из src/routes/metrics.js (экспортирована
 * как свойство роутера специально для этого теста). Формирует Prometheus
 * label-строку из объекта — кавычки, обратный слеш и перевод строки в
 * значении должны быть экранированы, иначе результат ломает Prometheus
 * text exposition format при скрейпе.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { labels } = require('../../src/routes/metrics');

describe('metrics.js: labels() — экранирование Prometheus label-значений', () => {
  test('пустой объект — пустая строка (без фигурных скобок)', () => {
    assert.equal(labels({}), '');
  });

  test('обычное значение без спецсимволов', () => {
    assert.equal(labels({ name: 'CoreSwitch' }), '{name="CoreSwitch"}');
  });

  test('несколько меток соединяются запятой в порядке ключей объекта', () => {
    assert.equal(labels({ a: '1', b: '2' }), '{a="1",b="2"}');
  });

  test('двойные кавычки в значении экранируются \\"', () => {
    assert.equal(labels({ name: 'Router "Core"' }), '{name="Router \\"Core\\""}');
  });

  test('обратный слеш экранируется ПЕРВЫМ (до кавычек), иначе экранирование кавычки задвоится', () => {
    // Порядок важен: если сначала экранировать кавычки, а потом бэкслеш,
    // то `\"` (уже экранированная кавычка) превратится в `\\"`, что сломает формат.
    assert.equal(labels({ name: 'A\\B' }), '{name="A\\\\B"}');
  });

  test('кавычка и бэкслеш вместе — итоговая строка валидна для Prometheus (каждый спецсимвол экранирован ровно один раз)', () => {
    const result = labels({ name: 'Router "Core" \\ Backup' });
    assert.equal(result, '{name="Router \\"Core\\" \\\\ Backup"}');
  });

  test('перевод строки в значении экранируется \\n (не разрывает строку метрики)', () => {
    const result = labels({ name: 'Line1\nLine2' });
    assert.equal(result, '{name="Line1\\nLine2"}');
    assert.ok(!result.includes('\n'), 'экранированное значение не должно содержать реальный перевод строки');
  });
});
