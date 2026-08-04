#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(process.cwd(), 'server/src/routes/apiV2ProxyRoutes.ts'), 'utf8');

const assertions = [
  {
    name: 'Open API key routes before fallback',
    before: "app.get('/api/profile'",
    after: "app.all('/*'",
  },
  {
    name: 'Public provider callbacks before webhook wildcard',
    before: "app.post('/webhook/digiflazz'",
    after: "app.all('/webhook/*'",
  },
  {
    name: 'Upload multipart proxy before fallback',
    before: "app.post('/upload'",
    after: "app.all('/*'",
  },
  {
    name: 'Upload list authorization before fallback',
    before: "app.get('/upload/list'",
    after: "app.all('/*'",
  },
  {
    name: 'Transaction member route before transaction wildcard',
    before: "app.all('/transactions'",
    after: "app.all('/transactions/*'",
  },
];

let failed = false;
for (const assertion of assertions) {
  const beforeIndex = source.indexOf(assertion.before);
  const afterIndex = source.indexOf(assertion.after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex > afterIndex) {
    failed = true;
    console.error(`fail ${assertion.name}`);
    continue;
  }
  console.log(`ok ${assertion.name}`);
}

if (failed) {
  process.exit(1);
}
