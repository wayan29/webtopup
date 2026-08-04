#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'server/src/index.ts');
const source = fs.readFileSync(indexPath, 'utf8');
const routePattern = /app\.register\((\w+), \{ prefix: `\$\{apiPrefix\}([^`]*)` \}\);/g;

const rows = [];
let match;
while ((match = routePattern.exec(source)) !== null) {
  const routeModule = match[1];
  const suffix = match[2] || '';
  rows.push({
    module: routeModule,
    legacy: `/v1${suffix}`,
    successor: `/api/v2${suffix}`,
  });
}

rows.push({ module: 'uploadRoutes', legacy: '/v1/upload*', successor: '/api/v2/upload*' });

const uniqueRows = rows
  .filter((row, index, all) => index === all.findIndex((candidate) => candidate.legacy === row.legacy))
  .sort((a, b) => a.legacy.localeCompare(b.legacy));

console.log('# API v1 Removal Readiness');
console.log('');
console.log('Generated from `server/src/index.ts`. Keep `/v1` deprecated until observed usage is zero for the agreed window.');
console.log('');
console.log('| Legacy prefix | Successor prefix | Legacy module | Status |');
console.log('| --- | --- | --- | --- |');
for (const row of uniqueRows) {
  console.log(`| \`${row.legacy}\` | \`${row.successor}\` | \`${row.module}\` | deprecated, observe usage |`);
}
