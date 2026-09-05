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
new required inputs, managed JSON output, architecture's boolean-flag scanner,
and selected type-aware flags. `npm run smoke:fallow` runs the same checks against the actual CLI schema
alongside the existing report, issue-type, resource, and version assertions.

Manifest v1 does **not** describe nested `coverage analyze` or built-in help flags.
The checker explicitly exempts only the known nested prefix and help flags;
the live smoke check separately verifies nested help and missing-input execution
contracts described below. This does not certify successful nested analysis.

Extra commands, optional flags, issue types, and output formats do not fail the
registry check. This is scoped development certification, not a general semantic
compatibility detector: it does not validate arbitrary forwarded flags, all
allowed values, all slash-only flows, or arbitrary report layouts. Required-input
checks cover advertised required flags/positionals not supplied by fixed registry
prefixes or managed output flags; help evidence extends this to selected nested
commands, not conditional argument constraints.
No schema probing or version gate is added to startup, autocomplete, or runtime
execution. Independently installed older/newer Fallow versions remain usable;
user-facing installed-capability diagnostics remain separate work (#77).

## Captured report and nested-command evidence

`reports-3.21.0.json` contains seven real CLI JSON reports and four projected help
contracts. `report-project.json` holds the complete tiny input project; its SHA-256
is recorded in the evidence. The capture script records the exact CLI tokens,
exit status, and report for each case:

- dead-code: one actionable unused export, exit 1 (findings, not a crash);
- health: no threshold findings, with an informational file score;
- similar-code status: pinned-model provenance with an isolated, missing model;
- similar-code discovery: the real missing-model failure, without inference;
- coverage analyze: missing runtime-coverage option value;
- similar-code inspect/review: required-input failures before any candidate read.

Regenerate deliberately from the repository root:

```sh
node scripts/report-certification.mjs --write
npm test
npm run smoke:fallow
```

The capture script verifies the pinned CLI version, creates and finally removes
an isolated temporary project/home/config/cache, and inherits neither Fallow
cloud/model overrides nor credentials. Its PATH contains only the repository's
pinned executables and the running Node directory. It never runs setup, cache
clear, fixes, or successful model inference. No optional companion installation
is attempted. Signature verification by the npm executable wrapper may use its
existing package-local verification marker.

Normalization is explicit: top-level `elapsed_ms` becomes 0; telemetry
`analysis_run_id` becomes `<RUN_ID>`; the status report's machine-specific model
cache path becomes `<ISOLATED_MODEL_CACHE>`. No finding, source location, action,
error, model identity, or completeness data is removed. Stderr is not archived;
these fixtures certify JSON stdout and exit codes, not diagnostic logging.

Help projection retains required Usage tokens and option value placeholders
(including optional values), not descriptions. A new required Usage token or a
changed/missing known option declaration fails certification; additive optional
options do not. This is a scoped parser for current help, not a general Clap
schema parser or proof that all declared options execute successfully.

`tests/report-certification.test.mjs` exercises JSON parsing, normalization,
bounded output, and readable complete-report retention using these captures.
It also injects **synthetic** partial type-aware metadata into the captured health
report to test advisory-state retention; that test is not live semantic evidence.
Mutation tests remove/change actionable fields, schema identity, required nested
inputs, and option arity. Live smoke recaptures evidence and requires the known
fields to match, allowing additive object fields. Array contents/counts are exact
for this fixed input, not a general comparison of arbitrary projects.

### Remaining #83 scope

This is an initial slice, not closure of #83. Successful `coverage analyze` needs
the optional `fallow-cov` companion, which is not in the current development
package. Model-backed discovery and successful source-grounded inspect/review
are not certified here. Additional representative security, duplication,
combined, and real partial reports also remain future coverage. These gaps must
not be inferred as supported from help-only or failure-path checks.
