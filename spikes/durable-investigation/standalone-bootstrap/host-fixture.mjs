// Only starts the adjacent fixed fixture; there is no executable/argv interface.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const deadline = Date.now() + 2000;
setTimeout(() => process.exit(5), Math.max(0, deadline - Date.now()));
const supervisor = spawn(process.execPath, [fileURLToPath(new URL('./supervisor-fixture.mjs', import.meta.url))], {
  detached: true,
  stdio: ['ignore', 1, 'ignore', 'pipe'],
});
supervisor.on('error', () => process.exit(6));
supervisor.stdio[3].on('error', () => process.exit(7));
supervisor.stdio[3].end(randomBytes(32));
