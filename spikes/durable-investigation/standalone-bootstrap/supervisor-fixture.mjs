// Bootstrap feasibility fixture only: not an authenticated supervisor.
import { createReadStream } from 'node:fs';

const deadline = Date.now() + 2500;
const expiry = setTimeout(() => process.exit(2), Math.max(0, deadline - Date.now()));
const input = createReadStream(null, { fd: 3, autoClose: true });
let length = 0;
input.on('data', chunk => {
  length += chunk.length;
  if (length > 32) process.exit(3);
});
input.on('error', () => process.exit(4));
input.on('end', () => {
  if (length !== 32) process.exit(4);
  process.stdout.write('READY\n');
  const control = createReadStream(null, { fd: 4, autoClose: true });
  let command = '';
  control.on('data', chunk => {
    command += chunk.toString('ascii');
    if (command.length > 2) process.exit(5);
  });
  control.on('error', () => process.exit(6));
  control.on('end', () => {
    if (command !== 'GO') process.exit(7);
    process.stdout.write('ALIVE\n');
    clearTimeout(expiry);
  });
});
