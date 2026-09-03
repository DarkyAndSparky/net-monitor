#!/usr/bin/env node
'use strict';
/**
 * scripts/check-syntax.js
 *
 * Синтаксис-чек каждого .js файла проекта (кроме node_modules/.git).
 * Тот же цикл, что раньше прогонялся вручную (find + node --check) при
 * каждом аудите за сессию — теперь часть CI и доступен локально одной
 * командой.
 *
 * Запуск: node scripts/check-syntax.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const files = walk(ROOT, []);
let hadError = false;

for (const file of files) {
  try {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    hadError = true;
    console.error(`СЛОМАН: ${path.relative(ROOT, file)}`);
    console.error(e.stderr?.toString() || e.message);
  }
}

console.log(`Проверено файлов: ${files.length}`);
if (hadError) {
  console.error('\nНайдены синтаксические ошибки.');
  process.exit(1);
}
console.log('Всё чисто.');
