#!/usr/bin/env node

const { spawnSync } = require('child_process');

const task = process.argv[2] || 'smoke';

const commands = {
  smoke: ['npm', ['run', 'api-v2:smoke']],
  mutation: ['npm', ['run', 'api-v2:smoke:mutations']],
  provider: ['npm', ['run', 'api-v2:smoke:transaction-create-readiness']],
  dryRun: ['npm', ['run', 'api-v2:dry-run:transaction-create']],
};

if (!commands[task]) {
  console.error(`Unknown staging task '${task}'. Use one of: ${Object.keys(commands).join(', ')}.`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run('node', ['scripts/smoke/api-v2-staging-readiness.js', task]);
run(...commands[task]);
