#!/usr/bin/env node

const fs = require('fs');

const reportPath = process.argv[2] || process.env.SMOKE_REPORT_PATH;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

if (!reportPath) {
  console.error('Usage: node scripts/smoke/write-smoke-step-summary.js <report-path>');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const summary = report.summary || {};
const failedChecks = (report.checks || []).filter((check) => check.status === 'failed').slice(0, 10);

const lines = [
  `## ${report.suite || 'Smoke'} Summary`,
  '',
  `- Passed: ${summary.passed || 0}`,
  `- Skipped: ${summary.skipped || 0}`,
  `- Failed: ${summary.failed || 0}`,
  `- Started: ${report.startedAt || '-'}`,
  `- Finished: ${report.finishedAt || '-'}`,
];

if (failedChecks.length > 0) {
  lines.push('', '| Check | Message |', '| --- | --- |');
  for (const check of failedChecks) {
    lines.push(`| ${check.name} | ${String(check.message || '').replace(/\|/g, '\\|')} |`);
  }
}

const output = `${lines.join('\n')}\n`;
if (summaryPath) {
  fs.appendFileSync(summaryPath, output);
} else {
  process.stdout.write(output);
}
