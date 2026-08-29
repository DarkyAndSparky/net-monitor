#!/usr/bin/env node
'use strict';
/**
 * scripts/sync-version.js
 *
 * package.json — единственный источник истины для версии. server.js уже
 * читает её оттуда динамически в рантайме (баннер, /api/health, «О системе»).
 * Но docs/index.html — статический файл (может жить отдельно на GitHub
 * Pages, без работающего сервера рядом) и README.md — версия там, если
 * упоминается буквально, не может быть прочитана динамически.
 *
 * Запуск: node scripts/sync-version.js
 * Находит в целевых файлах любое вхождение формата версии (NNwNN-bNN,
 * с необязательным префиксом v/"version":) и заменяет на текущую версию
 * из package.json. Не завязан на конкретную старую версию — работает
 * при любом bump'е без правки самого скрипта.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { version } = require(path.join(ROOT, 'package.json'));

// Формат версии проекта: 26w34-b01 (неделя года + номер билда на этой неделе)
const VERSION_RE = /\d{2}w\d{2}-b\d{2}/g;

const TARGETS = ['docs/index.html', 'README.md', 'netmonitor-roadmap.md'];

let totalReplacements = 0;
for (const rel of TARGETS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const content = fs.readFileSync(full, 'utf8');
  let count = 0;
  const updated = content.replace(VERSION_RE, (match) => {
    if (match !== version) count++;
    return version;
  });
  if (count > 0) {
    fs.writeFileSync(full, updated);
    console.log(`${rel}: обновлено вхождений — ${count}`);
    totalReplacements += count;
  } else {
    console.log(`${rel}: уже актуально`);
  }
}

console.log(`\nВерсия из package.json: ${version}`);
console.log(totalReplacements > 0 ? `Синхронизировано мест: ${totalReplacements}` : 'Всё уже было синхронизировано, менять нечего.');
