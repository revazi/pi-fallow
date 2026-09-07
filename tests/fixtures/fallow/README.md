# Fallow capability certification fixture

`schema-3.22.0.json` is a deterministic projection of the repository-pinned
Fallow 3.22.0 `schema --format json --quiet` output. It retains command names,
global/local flag names, short aliases, types, requiredness, allowed values,
output formats, and manifest/default-command identity. Descriptions and unrelated
resources are intentionally omitted; this is not a complete capability manifest
or a report-schema fixture.

The original single-line stdout has SHA-256
`f0850e8498cfcfaa8e80cf77fe1e7b5f2620039f66955216e470f28918d258ed`.

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

`reports-3.22.0.json` contains twelve real CLI JSON reports and four projected
help contracts. `report-project.json` and `report-partial-project.json` hold the
complete tiny input projects; both SHA-256 digests are recorded in the evidence.
The capture script records exact CLI tokens, exit status, and report for each case:

- dead-code: one actionable unused export, exit 1 (findings, not a crash);
- duplication: one cross-file clone group under explicit tiny-fixture thresholds;
- health: no threshold findings, with informational file scores;
- security: one source-backed command-injection candidate and attack-surface path;
- combined: deterministic dead-code/duplication findings and health context (bare
  combined analysis intentionally does not include the separate security surface);
- type-aware unavailable: advisory no-project evidence from the real companion;
- type-aware partial: one complete and one structurally blocked TypeScript project,
  preserving blocking-diagnostic omissions from the real companion;
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

Normalization is explicit: top-level and combined-child `elapsed_ms` become 0;
type-aware elapsed and phase timings become 0; telemetry `analysis_run_id` becomes
`<RUN_ID>`; the status report's machine-specific model cache path becomes
`<ISOLATED_MODEL_CACHE>`. No finding, source location, action,
error, model identity, or completeness data is removed. Stderr is not archived;
these fixtures certify JSON stdout and exit codes, not diagnostic logging.

Help projection retains required Usage tokens and option value placeholders
(including optional values), not descriptions. A new required Usage token or a
changed/missing known option declaration fails certification; additive optional
options do not. This is a scoped parser for current help, not a general Clap
schema parser or proof that all declared options execute successfully.

`tests/report-certification.test.mjs` exercises JSON parsing, normalization,
bounded output, and readable complete-report retention using these captures.
Real unavailable and partial companion reports test advisory-state retention.
Mutation tests remove/change actionable fields, schema identity, required nested
inputs, and option arity. Live smoke recaptures evidence and requires the known
fields to match, allowing additive object fields. Array contents/counts are exact
for this fixed input, not a general comparison of arbitrary projects.

## Optional signed `fallow-cov` evidence

`coverage-report-3.22.0.json` is a successful local `coverage analyze` capture
from `coverage-project.json`. Node 24 executes one function under native V8
coverage while leaving one tracked function cold; Fallow 3.22.0 and the signed
`@fallow-cli/fallow-cov` 0.4.1 sidecar then emit one non-auto-fixable cold-code
finding, blast-radius and importance context, capture-quality discriminators,
and explicit local/unknown-production provenance.

The sidecar package declares `SEE LICENSE IN LICENSE` and is proprietary. This
repository does not add it to normal dependencies. The dedicated CI smoke lane
fetches the exact package ephemerally with npm install scripts disabled, resolves
the one signed platform package, and passes its binary explicitly to Fallow.
Thus normal `npm install` does not create `~/.fallow/bin` links, and ordinary
unit tests remain offline. Fallow still verifies the adjacent signature before
execution. A successful local capture in the certified version is evidence of
that command path, not a license entitlement or a claim about continuous/cloud
features; package terms remain authoritative.

Regenerate and verify deliberately on Node 24:

```sh
npm exec --yes --ignore-scripts --package=@fallow-cli/fallow-cov@0.4.1 -- \
  node scripts/fallow-cov-certification.mjs --write
npm run smoke:fallow-cov
```

The script checks the wrapper package name/version/license, requires exactly one
signed platform binary, uses isolated temporary project/home/config/cache/V8
roots, and removes them in `finally`. It does not inherit cloud credentials or
select cloud mode. Only top-level `elapsed_ms` and telemetry `analysis_run_id`
are normalized. The checked-in report retains every runtime finding, action,
discriminator, capture-quality value, and provenance field. The source-project
digest and Node major are bound in the evidence.

Offline tests preserve the complete JSON and mutation-check selected schema,
summary, path, action, and tracking-state fields while allowing additive object
fields. Normalized overlay coverage is intentionally tracked as #87 because the
successful report exposed that existing `coverage-analyze` output is currently
retained raw but not surfaced as navigator findings.

### Remaining #83 scope

This remains short of full closure of #83. Model-backed discovery and successful
source-grounded inspect/review are not certified until the user explicitly runs
Fallow's pinned-model setup. Audit/change-gate and other specialized layouts
remain future coverage. Help/failure evidence must not be inferred as successful
model-backed analysis.
