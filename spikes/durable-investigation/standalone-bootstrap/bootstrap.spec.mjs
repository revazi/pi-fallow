import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('private pipe bootstrap survives direct host SIGKILL', { timeout: 6000 }, async () => {
  const host = spawn(process.execPath, [fileURLToPath(new URL('./host-fixture.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
  });
  const exit = once(host, 'exit');
  const outputEnd = once(host.stdout, 'end');
  host.stdio[3].on('error', () => {});
  let received = '';
  let killed = false;
  host.stdout.on('data', chunk => {
    received += chunk.toString('ascii');
    if (!killed && received.includes('READY\n')) {
      // Only the still-held direct test child is signalled; no recovered PID is used.
      killed = host.kill('SIGKILL');
    }
  });
  const [code, signal] = await exit;
  // Release the fixture only after observing host exit, not after a delay.
  host.stdio[3].end('GO');
  await outputEnd;
  assert.equal(killed, true);
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  assert.equal(received, 'READY\nALIVE\n');
});
