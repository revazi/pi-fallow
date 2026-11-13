import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('private pipe bootstrap survives direct host SIGKILL', { timeout: 6000 }, async () => {
  const host = spawn(process.execPath, [fileURLToPath(new URL('./host-fixture.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exit = once(host, 'exit');
  let received = '';
  let killed = false;
  host.stdout.on('data', chunk => {
    received += chunk.toString('ascii');
    if (!killed && received.includes('READY\n')) {
      // Only the still-held direct test child is signalled; no recovered PID is used.
      killed = host.kill('SIGKILL');
    }
  });
  await once(host.stdout, 'end');
  const [code, signal] = await exit;
  assert.equal(killed, true);
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  assert.equal(received, 'READY\nALIVE\n');
});
