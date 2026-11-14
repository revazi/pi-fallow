// Investigation primitive only: no transport, authority, persistence or supervisor.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_FRAME = 64 * 1024;
export const MAX_CONNECTION_BYTES = 1024 * 1024;
export const MAX_MESSAGES = 32;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{32}$/;
const TYPES = new Set(['HELLO', 'CHALLENGE', 'AUTH', 'START', 'STATUS', 'RESULT']);

// A fixed-position array of ASCII strings is the entire wire grammar. JSON's
// one permitted representation is the exact output of JSON.stringify; decode
// and re-encode equality rejects alternate escapes, whitespace and duplicates.
function validFields(fields) {
  return Array.isArray(fields) && fields.length === 10 &&
    fields.every((v) => typeof v === 'string' && /^[\x20-\x7e]*$/.test(v)) &&
    fields[0] === '1' && HEX16.test(fields[1]) && HEX16.test(fields[2]) &&
    HEX32.test(fields[3]) && HEX32.test(fields[4]) &&
    /^(0|[1-9][0-9]{0,5})$/.test(fields[5]) && HEX16.test(fields[6]) &&
    HEX32.test(fields[7]) && TYPES.has(fields[8]) && fields[9].length <= 32768;
}

export function encode(fields) {
  if (!validFields(fields)) throw new Error('invalid message');
  const bytes = Buffer.from(JSON.stringify(fields), 'ascii');
  if (bytes.length > MAX_FRAME) throw new Error('message too large');
  return bytes;
}

export function decode(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FRAME || bytes.some((b) => b > 127)) throw new Error('invalid encoding');
  let fields;
  try { fields = JSON.parse(bytes.toString('ascii')); } catch { throw new Error('invalid encoding'); }
  if (!validFields(fields) || !encode(fields).equals(bytes)) throw new Error('noncanonical message');
  return fields;
}

// Length-prefixed context means no concatenation ambiguity. Direction and type
// are authenticated independently as well as appearing in the message bytes.
export function tag(key, direction, fields) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !['host', 'supervisor'].includes(direction)) throw new Error('invalid MAC context');
  const message = encode(fields);
  const mac = createHmac('sha256', key);
  for (const part of [Buffer.from('pi-fallow-155-prototype-v1'), Buffer.from(direction), Buffer.from(fields[8]), message]) {
    const size = Buffer.alloc(4); size.writeUInt32BE(part.length);
    mac.update(size).update(part);
  }
  return mac.digest();
}

export function verify(key, direction, fields, supplied) {
  if (!Buffer.isBuffer(supplied) || supplied.length !== 32) return false;
  return timingSafeEqual(tag(key, direction, fields), supplied);
}

// Wire frame is length || canonical-message || fixed 32-byte tag. The length
// includes the tag; no buffering happens for a declared oversized frame.
export function frame(fields, mac) {
  const bytes = encode(fields);
  if (!Buffer.isBuffer(mac) || mac.length !== 32 || bytes.length + 32 > MAX_FRAME) throw new Error('invalid frame');
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length + 32);
  return Buffer.concat([header, bytes, mac]);
}

export class FrameReader {
  #header = Buffer.alloc(4); #headerBytes = 0; #body = null; #bodyBytes = 0;
  #total = 0; #count = 0; #failed = false;
  push(chunk) {
    if (this.#failed) throw new Error('reader closed');
    try { return this.#push(chunk); } catch (e) { this.#failed = true; this.#body = null; throw e; }
  }
  #push(chunk) {
    if (!Buffer.isBuffer(chunk) || (this.#total += chunk.length) > MAX_CONNECTION_BYTES) throw new Error('connection byte limit');
    const results = [];
    let pos = 0;
    while (pos < chunk.length) {
      if (!this.#body) {
        const n = Math.min(4 - this.#headerBytes, chunk.length - pos);
        chunk.copy(this.#header, this.#headerBytes, pos, pos + n); pos += n; this.#headerBytes += n;
        if (this.#headerBytes < 4) continue;
        const length = this.#header.readUInt32BE();
        if (length <= 32 || length > MAX_FRAME || ++this.#count > MAX_MESSAGES) throw new Error('invalid frame length or count');
        this.#body = Buffer.alloc(length); this.#bodyBytes = 0;
      }
      const n = Math.min(this.#body.length - this.#bodyBytes, chunk.length - pos);
      chunk.copy(this.#body, this.#bodyBytes, pos, pos + n); pos += n; this.#bodyBytes += n;
      if (this.#bodyBytes === this.#body.length) {
        results.push({ fields: decode(this.#body.subarray(0, -32)), mac: Buffer.from(this.#body.subarray(-32)) });
        this.#body = null; this.#headerBytes = 0;
      }
    }
    return results;
  }
  end() {
    if (this.#failed || this.#headerBytes || this.#body) throw new Error('truncated frame');
    this.#failed = true;
  }
}

// Call only after verifying the MAC and challenge/identity/binding context.
// Per-connection state cannot replace durable idempotency in a supervisor.
export class Sequence {
  #next = 0; #requests = new Set();
  accept(fields) {
    if (!validFields(fields) || Number(fields[5]) !== this.#next || this.#requests.has(fields[6]) || this.#next >= MAX_MESSAGES) throw new Error('replay or sequence error');
    this.#next++; this.#requests.add(fields[6]);
  }
}
