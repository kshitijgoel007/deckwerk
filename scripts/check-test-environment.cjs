const net = require('node:net');

/**
 * The full integration suite starts localhost collaboration servers and real
 * Electron/Chromium, ffmpeg, importer, semaphore, and filesystem-watcher
 * processes. Restricted agent sandboxes commonly deny those OS capabilities;
 * fail before Vitest fans out and obscures the cause behind dozens of EPERM,
 * null-exit, timeout, and EMFILE failures.
 */
const server = net.createServer();

server.once('error', (error) => {
  console.error(`
Full test suite requires execution outside the restricted sandbox.

The suite binds localhost and launches real Electron/Chromium, ffmpeg,
importer, semaphore, and filesystem-watcher processes. In an agent session,
grant this test command permission to run outside the sandbox and rerun it.

Focused pure unit tests can still be run inside the sandbox with:
  npx vitest run test/<name>.test.ts

Environment preflight failed: ${error.message}
`);
  process.exitCode = 1;
});

server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
  server.close();
});
