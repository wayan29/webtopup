#!/usr/bin/env node

const fs = require('fs');

const command = process.argv[2] || 'smoke';
const env = process.env;

const commandRequirements = {
  smoke: [
    'API_BASE_URL',
    'SMOKE_EMAIL',
    'SMOKE_PASSWORD',
  ],
  mutation: [
    'API_BASE_URL',
    'SMOKE_EMAIL',
    'SMOKE_PASSWORD',
    'RUN_API_V2_MUTATION_SMOKE',
    'MONGO_URI',
    'MONGO_DB',
  ],
  provider: [
    'API_BASE_URL',
    'SMOKE_EMAIL',
    'SMOKE_PASSWORD',
    'SMOKE_MEMBER_EMAIL',
    'SMOKE_MEMBER_PASSWORD',
    'RUN_PROVIDER_SMOKE',
    'PROVIDER_MODE',
  ],
  dryRun: [
    'API_BASE_URL',
    'MONGO_URI',
    'MONGO_DB',
    'RUN_TRANSACTION_CREATE_DRY_RUN',
    'CONFIRM_TRANSACTION_CREATE_DRY_RUN_BALANCE_CHANGE',
    'DRY_RUN_MEMBER_EMAIL',
    'DRY_RUN_MEMBER_PASSWORD',
    'DRY_RUN_ADMIN_EMAIL',
    'DRY_RUN_ADMIN_PASSWORD',
    'DRY_RUN_PRODUCT_CODE',
    'DRY_RUN_TARGET',
  ],
};

const expectedValues = {
  RUN_API_V2_MUTATION_SMOKE: '1',
  RUN_PROVIDER_SMOKE: '1',
  RUN_TRANSACTION_CREATE_DRY_RUN: '1',
  CONFIRM_TRANSACTION_CREATE_DRY_RUN_BALANCE_CHANGE: '1',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isPlaceholder(value) {
  return /example\.com|replace-with|your-|APPROVED_|password@|^https:\/\/staging\.example\.com$/i.test(value);
}

function validateUrl(name) {
  const value = env[name];
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      fail(`${name} must use http or https.`);
    }
  } catch {
    fail(`${name} must be a valid URL.`);
  }
}

function validateMongo(name) {
  const value = env[name];
  if (!value) return;
  if (!/^mongodb(\+srv)?:\/\//.test(value)) {
    fail(`${name} must be a MongoDB connection string.`);
  }
}

const requirements = commandRequirements[command];
if (!requirements) {
  fail(`Unknown staging readiness command '${command}'. Use one of: ${Object.keys(commandRequirements).join(', ')}.`);
}

const missing = requirements.filter((name) => !String(env[name] || '').trim());
if (missing.length > 0) {
  fail(`Missing required staging env for ${command}: ${missing.join(', ')}`);
}

for (const [name, expected] of Object.entries(expectedValues)) {
  if (requirements.includes(name) && env[name] !== expected) {
    fail(`${name} must be set to ${expected} for ${command}.`);
  }
}

for (const name of requirements) {
  const value = String(env[name] || '');
  if (isPlaceholder(value)) {
    fail(`${name} still looks like a placeholder. Refusing to continue.`);
  }
}

validateUrl('API_BASE_URL');
validateUrl('API_V2_DIRECT_URL');
validateUrl('PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL');
validateUrl('PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL');
validateUrl('GAME_VALIDATION_CODASHOP_BASE_URL');
validateUrl('GAME_VALIDATION_GOPAY_BASE_URL');
validateMongo('MONGO_URI');
validateMongo('SMOKE_MONGO_URI');

if (command === 'provider' && env.PROVIDER_MODE === 'sandbox') {
  const sandboxRequired = [
    'CONFIRM_PROVIDER_BACKEND_SANDBOX',
    'CONFIRM_GAME_VALIDATION_SANDBOX',
    'PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL',
    'PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL',
    'GAME_VALIDATION_CODASHOP_BASE_URL',
    'GAME_VALIDATION_GOPAY_BASE_URL',
  ];
  const missingSandbox = sandboxRequired.filter((name) => !String(env[name] || '').trim());
  if (missingSandbox.length > 0) {
    fail(`Missing provider sandbox env: ${missingSandbox.join(', ')}`);
  }
  if (env.CONFIRM_PROVIDER_BACKEND_SANDBOX !== '1' || env.CONFIRM_GAME_VALIDATION_SANDBOX !== '1') {
    fail('Provider sandbox confirmations must be set to 1.');
  }
}

if (command === 'provider' && env.PROVIDER_MODE === 'live') {
  fail('Provider live smoke is intentionally blocked by this readiness checker. Use sandbox or run live manually with explicit approval.');
}

if (command === 'dryRun' && env.DRY_RUN_OUTPUT_PATH) {
  const parent = require('path').dirname(env.DRY_RUN_OUTPUT_PATH);
  if (!fs.existsSync(parent)) {
    fail(`DRY_RUN_OUTPUT_PATH parent does not exist: ${parent}`);
  }
}

console.log(`Staging readiness OK for ${command}.`);
