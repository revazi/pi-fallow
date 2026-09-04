# Fallow capability certification fixture

`schema-3.21.0.json` is a deterministic projection of the repository-pinned
Fallow 3.21.0 `schema --format json --quiet` output. It retains command names,
global/local flag names, short aliases, types, requiredness, allowed values,
output formats, and manifest/default-command identity. Descriptions and unrelated
resources are intentionally omitted; this is not a complete capability manifest
or a report-schema fixture.

The original single-line stdout has SHA-256
`ca397e67666058ccb74068811576baef6bdfbeb80579589d093242b7e1e6ec53`.

## Regeneration

From the repository root, after installing the pinned development dependencies:

```sh
./node_modules/.bin/fallow schema --format json --quiet > /tmp/pi-fallow-certified-schema.json
node --input-type=module <<'NODE'
import fs from "node:fs";
const schema = JSON.parse(fs.readFileSync("/tmp/pi-fallow-certified-schema.json", "utf8"));
const flag = ({name, short, type, required, possible_values}) => ({name, short, type, required, possible_values});
const {name, version, manifest_version, default_command, output_formats} = schema;
const fixture = {
  name, version, manifest_version, default_command, output_formats,
  global_flags: schema.global_flags.map(flag),
  commands: schema.commands.map(({name, flags}) => ({name, flags: flags.map(flag)})),
};
fs.writeFileSync(`tests/fixtures/fallow/schema-${version}.json`, JSON.stringify(fixture, null, 2) + "\n");
NODE
```

Review the diff and update the test fixture reference and source hash deliberately
when changing the certified target. Tests require the fixture version to match
`package.json`'s pinned Fallow development dependency.

## Scope and limits

`tests/schema-registry-check.test.mjs` checks every tool registry entry against this
fixture, with mutation tests for missing commands, fixed flags, target metadata,
managed JSON output, architecture's boolean-flag scanner, and selected type-aware
flags. `npm run smoke:fallow` runs the same checks against the actual CLI schema
alongside the existing report, issue-type, resource, and version assertions.

Manifest v1 does **not** describe nested `coverage analyze` or built-in help flags.
The checker explicitly exempts only the known nested prefix and help flags;
the live smoke check separately verifies `coverage analyze --help`. This does
not certify the nested command's full argument or output contract.

Extra commands, optional flags, issue types, and output formats do not fail the
registry check. This is scoped development certification, not a general semantic
compatibility detector: it does not validate arbitrary forwarded flags, all
allowed values, new required arguments, all slash-only flows, or report layouts.
No schema probing or version gate is added to startup, autocomplete, or runtime
execution. Independently installed older/newer Fallow versions remain usable;
user-facing installed-capability diagnostics remain separate work (#77).
