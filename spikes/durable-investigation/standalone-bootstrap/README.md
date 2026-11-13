# Bootstrap-only feasibility probe (#155)

**Blocked/incomplete; not a standalone supervisor implementation.** This is a
small synthetic bootstrap experiment, not authenticated reconnect, durable
intent, launch deduplication, capture, or evidence admission. Do not use it for
recovery or as a security boundary. It does not establish the #155 deliverables
or authorize changes to Durable or Fallow.

```sh
node --test spikes/durable-investigation/standalone-bootstrap/bootstrap.spec.mjs
```

On Darwin 27.0.0, Node v24.12.0, the test passed: a fixed directly spawned
fixture consumed 32 random bytes over inherited fd 3, announced readiness, and
continued long enough to report after its directly observed host was killed by
SIGKILL. Neither bytes nor executable input come from an external request. The
host and fixture have short self-expiry deadlines; no recovered PID or process
group is signalled. The test controller signals only its live direct host child.
It does not prove the bytes remain secret, socket authentication, safe cleanup,
containment, process identity, reboot behavior, or any production property.

The merged design describes peer credentials as supplementary where supported,
while also saying to block if peer checks cannot be established. The Node
`net.Socket` API on the observed runtime has no `getPeerCredentials` accessor;
this observation is not an exhaustive proof that every native approach is
unavailable. Native compilation and acquisition are excluded here. A clear
resolution of that design tension, plus a complete reviewed bounded mutual
challenge protocol and lifecycle implementation, remains necessary. The probe
does not resolve it by treating this bootstrap as authentication.
