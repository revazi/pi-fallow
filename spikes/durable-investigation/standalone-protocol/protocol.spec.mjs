import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, tag, verify, frame, FrameReader, Sequence, MAX_FRAME, MAX_MESSAGES } from './protocol.mjs';

const key = Buffer.alloc(32);
const fields = ['1', '1'.repeat(32), '2'.repeat(32), '3'.repeat(64), '4'.repeat(64), '0', '5'.repeat(32), '6'.repeat(64), 'START', ''];

test('canonical fixed vector and direction-separated MAC', () => {
  const bytes = encode(fields);
  assert.equal(bytes.toString(), JSON.stringify(fields));
  assert.deepEqual(decode(bytes), fields);
  const mac = tag(key, 'host', fields);
  assert.equal(mac.toString('hex'), '6e909979792f0eea71bf10be46bded5e17d2c0baca0d780ce2c70dcbd8bb1cb8');
  assert.equal(verify(key, 'host', fields, mac), true);
  assert.equal(verify(key, 'supervisor', fields, mac), false);
  assert.equal(verify(Buffer.alloc(32, 1), 'host', fields, mac), false);
  assert.equal(verify(key, 'host', [...fields.slice(0, 8), 'STATUS', ''], mac), false);
  assert.equal(verify(key, 'host', fields, Buffer.alloc(1)), false);
});

test('reject noncanonical, unsupported and invalid representations', () => {
  assert.throws(() => decode(Buffer.from(` ${JSON.stringify(fields)}`)));
  assert.throws(() => decode(Buffer.from(JSON.stringify(fields).replace('START', '\\u0053TART'))));
  assert.throws(() => decode(Buffer.from('[1,1]')));
  assert.throws(() => decode(Buffer.from([0xff])));
  assert.throws(() => encode([...fields, 'extra']));
  assert.throws(() => encode([...fields.slice(0, 5), '00', ...fields.slice(6)]));
  assert.throws(() => encode([...fields.slice(0, 9), 'é']));
});

test('bounded fragmented framing and truncation', () => {
  const wire = frame(fields, tag(key, 'host', fields));
  const reader = new FrameReader();
  let results = [];
  for (const byte of wire) results = results.concat(reader.push(Buffer.from([byte])));
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].fields, fields);
  assert.equal(verify(key, 'host', results[0].fields, results[0].mac), true);
  reader.end();
  assert.throws(() => reader.push(Buffer.alloc(0)));
  const truncated = new FrameReader(); truncated.push(wire.subarray(0, -1));
  assert.throws(() => truncated.end());
  assert.throws(() => truncated.push(wire.subarray(-1)));
  const bad = Buffer.alloc(4); bad.writeUInt32BE(MAX_FRAME + 1);
  const oversized = new FrameReader(); assert.throws(() => oversized.push(bad));
  assert.throws(() => oversized.push(wire));
  const many = new FrameReader();
  for (let i = 0; i < MAX_MESSAGES; i++) many.push(wire);
  assert.throws(() => many.push(wire));
});

test('sequences and request identifiers cannot be replayed', () => {
  const seq = new Sequence(); seq.accept(fields);
  assert.throws(() => seq.accept(fields));
  assert.throws(() => seq.accept([...fields.slice(0, 5), '1', ...fields.slice(6)]));
  const second = [...fields.slice(0, 5), '1', '7'.repeat(32), ...fields.slice(7)];
  seq.accept(second);
  assert.throws(() => seq.accept([...second.slice(0, 5), '3', ...second.slice(6)]));
});
