const fs = require('fs');

function createSmokeReporter(suite) {
  const checks = [];
  const startedAt = new Date();
  const reportPath = (process.env.SMOKE_REPORT_PATH || '').trim();

  const record = (status, name, details = {}) => {
    checks.push({
      status,
      name,
      ...details,
      timestamp: new Date().toISOString(),
    });
  };

  const write = (summary = {}) => {
    if (!reportPath) {
      return;
    }
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          suite,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          summary,
          checks,
        },
        null,
        2,
      )}\n`,
    );
  };

  return { record, write };
}

module.exports = { createSmokeReporter };
