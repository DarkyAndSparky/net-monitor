#!/usr/bin/env node
'use strict';
/**
 * scripts/check-inline-scripts.js
 *
 * Извлекает inline <script>...</script> блоки из статических HTML-файлов
 * (docs/index.html — у public/index.html весь JS вынесен в app.js отдельно,
 * там нечего извлекать) и синтаксис-чекает каждый через node --check.
 * Раньше это проверялось только вручную при аудите — теперь часть CI.
 *
 * Запуск: node scripts/check-inline-scripts.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['docs/index.html'];

let hadError = false;

for (const rel of TARGETS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const content = fs.readFileSync(full, 'utf8');
  const scripts = [...content.matchAll(/<script>([\s\S]*?)<\/script>/g)];

  if (!scripts.length) {
    console.log(`${rel}: inline <script> не найдено`);
    continue;
  }

  scripts.forEach((m, i) => {
    const code = m[1];
    const tmpFile = path.join(os.tmpdir(), `inline-script-check-${path.basename(rel)}-${i}.js`);
    fs.writeFileSync(tmpFile, code);
    try {
      execFileSync('node', ['--check', tmpFile], { stdio: 'pipe' });
      console.log(`${rel}: блок ${i} (${code.length} симв.) — OK`);
    } catch (e) {
      hadError = true;
      console.error(`${rel}: блок ${i} — СИНТАКСИЧЕСКАЯ ОШИБКА`);
      console.error(e.stderr?.toString() || e.message);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
}

if (hadError) {
  console.error('\nНайдены синтаксические ошибки в inline-скриптах.');
  process.exit(1);
}
console.log('\nВсе inline-скрипты синтаксически корректны.');
