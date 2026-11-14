# Protocol primitive experiment (#155) — incomplete

This is **not a supervisor**, an authenticated session, a launch API, or a
recovery mechanism. Do not use these primitives as authority. The standalone
supervisor acceptance criteria remain unmet; the bootstrap-only experiment is
separate. This milestone explores encoding and framing only.

```
node --test spikes/durable-investigation/standalone-protocol/protocol.spec.mjs
```

Observed on Darwin 27.0.0 arm64, Node v24.12.0: four tests passed. The fixed
MAC vector is a regression vector generated with the Node implementation, not
independent cryptographic validation or native security evidence.

## Experimental wire primitive

A frame is a big-endian 32-bit length (1–65536, including a 32-byte tag),
canonical message bytes and tag. The message is a fixed ten-element JSON array
of ASCII strings in this order: version (`1`), 16-byte instance and attempt IDs,
32-byte client and server challenges, decimal sequence, 16-byte request ID,
32-byte binding digest, message type, payload. Binary values are lowercase hex.
The only valid encoding is the byte-for-byte `JSON.stringify` representation;
ASCII validation and re-encoding equality reject whitespace, alternative escapes,
noncanonical values, objects, duplicate-field representations and extra fields.
This deliberately restricted JSON array is an experimental departure from the
merged design's suggested canonical CBOR; no arbitrary JSON object is MACed.
Payload syntax and semantics are **not defined**. A frame reader bounds bytes,
messages and allocation; callers must additionally enforce connection counts,
timeouts, handshake states and total service lifetime.

HMAC-SHA-256 covers four independently 32-bit-length-prefixed byte strings:
`pi-fallow-155-prototype-v1`, direction (`host` or `supervisor`), message type,
and canonical message. A sequence helper rejects replay and repeated request
IDs on a single connection, but **does not authenticate**: callers must first
verify MAC, both fresh challenges, instance, attempt, binding and handshake
state. None of that handshake or validation is implemented here. Cross-session
idempotence must be held by the living supervisor, not this helper.

No peer-credential policy, bootstrap, persisted pre-spawn authority, mutual
challenge exchange, direct-child lifecycle, deadlines, immutable capture,
reconnect or negative authority tests are implemented. No safe recovered-PID
signalling or descendant containment is claimed. Durable integration and
production remain no-go. The merged design's peer-check tension remains a
policy question: the Node API observation in the bootstrap README does not
establish native checks or justify claiming peer checks passed.
