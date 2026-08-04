#!/usr/bin/env node

const fs = require('fs');

const logPath = process.argv[2] || process.env.API_V1_USAGE_LOG_PATH;

if (!logPath) {
  console.error('Usage: node scripts/smoke/api-v1-usage-report.js <node-log-path>');
  process.exit(1);
}

const content = fs.readFileSync(logPath, 'utf8');
const rows = new Map();

for (const line of content.split(/\r?\n/)) {
  if (!line.includes('Deprecated API v1 request observed')) {
    continue;
  }

  let event = null;
  const jsonStart = line.indexOf('{');
  if (jsonStart >= 0) {
    try {
      event = JSON.parse(line.slice(jsonStart));
    } catch {
      event = null;
    }
  }

  const method = event?.method || line.match(/method[=:]"?([A-Z]+)/)?.[1] || 'UNKNOWN';
  const path = event?.path || line.match(/path[=:]"?([^",\s]+)/)?.[1] || '/v1/*';
  const statusCode = event?.statusCode || line.match(/statusCode[=:](\d+)/)?.[1] || 'unknown';
  const userAgent = event?.userAgent || '';
  const ip = event?.ip || '';
  const key = `${method} ${path} ${statusCode}`;
  const current = rows.get(key) || { method, path, statusCode, count: 0, userAgents: new Set(), ips: new Set() };
  current.count += 1;
  if (userAgent) current.userAgents.add(userAgent);
  if (ip) current.ips.add(ip);
  rows.set(key, current);
}

console.log('# API v1 Usage Report');
console.log('');
console.log(`Source: \`${logPath}\``);
console.log('');

if (rows.size === 0) {
  console.log('No deprecated API v1 usage entries found.');
  process.exit(0);
}

console.log('| Method | Path | Status | Count | User Agents | IPs |');
console.log('| --- | --- | --- | ---: | --- | --- |');
for (const row of [...rows.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))) {
  console.log(
    `| ${row.method} | \`${row.path}\` | ${row.statusCode} | ${row.count} | ${[...row.userAgents].slice(0, 3).join(', ') || '-'} | ${[
      ...row.ips,
    ].slice(0, 3).join(', ') || '-'} |`,
  );
}
