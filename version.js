/**
 * version.js — единый источник правды для версии проекта.
 *
 * Формат: MAJOR.MINOR_YYwWW-TYPE-NN
 *   YY   — две последние цифры года (26 = 2026)
 *   WW   — номер недели ISO 8601 (всегда 2 цифры)
 *   TYPE — тип сборки: a (alpha) | b (beta) | rc | r (release)
 *   NN   — порядковый номер сборки в неделе (01, 02...)
 *
 * Примеры:
 *   0.9_26w32-b01    ← первая бета 32-й недели 2026
 *   1.0_26w40-rc01   ← первый релиз-кандидат
 *   1.0_26w41-r01    ← первый релиз
 *   1.1_27w01-a01    ← первая альфа 1-й недели 2027
 *
 * КАК ОБНОВЛЯТЬ:
 *   1. Меняем поля в VERSION ниже
 *   2. node version.js --sync   →  обновит package.json, docs/index.html,
 *                                  README.md, CHANGELOG.md
 */

const VERSION = {
  major: 0,
  minor: 9,
  year:  26,    // две цифры года
  week:  32,
  type:  'b',   // a | b | rc | r
  build: 1,
};

// ── Вычисляемые строки ────────────────────────────────────────────────
const ww     = String(VERSION.week).padStart(2, '0');
const nn     = String(VERSION.build).padStart(2, '0');
const SHORT  = `${VERSION.major}.${VERSION.minor}`;
const FULL   = `${SHORT}_${VERSION.year}w${ww}-${VERSION.type}${nn}`;  // 0.9_26w32-b01
const SEMVER = `${VERSION.major}.${VERSION.minor}.${VERSION.build}`;   // для package.json

module.exports = { ...VERSION, SHORT, FULL, SEMVER };

// ── CLI: node version.js --sync ───────────────────────────────────────
if (require.main === module && process.argv.includes('--sync')) {
  const fs   = require('fs');
  const path = require('path');
  const ROOT = __dirname;
  const updated = [];

  // Паттерн для поиска любой предыдущей версии в том же формате
  const VERSION_RE = /\d+\.\d+_\d{2}w\d{2}-(?:a|b|rc|r)\d{2}/g;

  // 1. package.json
  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.version = SEMVER;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    updated.push('package.json');
  }

  // 2. docs/index.html
  const docsPath = path.join(ROOT, 'docs', 'index.html');
  if (fs.existsSync(docsPath)) {
    let html = fs.readFileSync(docsPath, 'utf-8');
    html = html.replace(VERSION_RE, FULL);
    // sidebar badge
    html = html.replace(
      /<div class="version">v?[^<]*<\/div>/,
      `<div class="version">v${FULL}</div>`
    );
    fs.writeFileSync(docsPath, html);
    updated.push('docs/index.html');
  }

  // 3. README.md
  const readmePath = path.join(ROOT, 'README.md');
  if (fs.existsSync(readmePath)) {
    let md = fs.readFileSync(readmePath, 'utf-8');
    md = md.replace(VERSION_RE, FULL);
    // badge shields.io
    md = md.replace(
      /!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-[^)]+\)/g,
      `![Version](https://img.shields.io/badge/version-${FULL.replace(/-/g, '--')}-blue)`
    );
    fs.writeFileSync(readmePath, md);
    updated.push('README.md');
  }

  // 4. CHANGELOG.md — добавляем секцию если её нет
  const clPath = path.join(ROOT, 'CHANGELOG.md');
  if (fs.existsSync(clPath)) {
    let cl = fs.readFileSync(clPath, 'utf-8');
    if (!cl.includes(`[${FULL}]`)) {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `\n## [${FULL}] — ${today}\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n`;
      cl = cl.replace('## [Unreleased]', `## [Unreleased]${entry}`);
      fs.writeFileSync(clPath, cl);
      updated.push('CHANGELOG.md');
    }
  }

  console.log(`\n✓ Версия: ${FULL}  (semver: ${SEMVER})`);
  console.log(`  Обновлено: ${updated.join(', ') || 'ничего (файлы не найдены)'}`);
}
