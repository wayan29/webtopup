const fs = require('fs');
const os = require('os');
const path = require('path');

function acquireSmokeLock(label) {
  const lockPath = path.join(os.tmpdir(), 'webtopup-api-v2-smoke-suite.lock');
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n${label}\n`);
  } catch {
    console.error(`Refusing to run ${label} smoke while another API v2 smoke run holds ${lockPath}.`);
    process.exit(1);
  }

  const releaseLock = () => {
    if (lockFd === null) return;
    try {
      fs.closeSync(lockFd);
    } catch {
      // best effort cleanup
    }
    lockFd = null;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort cleanup
    }
  };

  process.on('exit', releaseLock);
  process.on('SIGINT', () => {
    releaseLock();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    releaseLock();
    process.exit(143);
  });

  return releaseLock;
}

module.exports = { acquireSmokeLock };
