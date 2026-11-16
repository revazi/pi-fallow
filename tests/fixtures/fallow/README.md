# Fallow capability certification fixture

`schema-3.43.1.json` is a deterministic projection of the repository-pinned
Fallow 3.43.1 `schema --format json --quiet` output. It retains command names,
global/local flag names, short aliases, types, requiredness, allowed values,
output formats, and manifest/default-command identity. Descriptions and unrelated
resources are intentionally omitted; this is not a complete capability manifest
or a report-schema fixture.

The original single-line stdout has SHA-256
`560595bf0337473150f08953426d3551dedb12189b7a826cff66e94b88a2bda8`.

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
const capabilities = {
  ...fixture,
  issue_types: schema.issue_types.map(({id, command, result_key}) => ({id, command, result_key})),
  related_schemas: Object.fromEntries(Object.entries(schema.related_schemas).filter(([key]) => key.endsWith("_command"))),
  mcp_resources: {resources: schema.mcp_resources.resources.map(({uri}) => ({uri}))},
};
fs.writeFileSync(`tests/fixtures/fallow/capabilities-${version}.json`, JSON.stringify(capabilities, null, 2) + "\n");
NODE
```

The 3.36 and 3.42 projections and captures remain historical evidence. The reviewed 3.42
comparison adds optional commands/flags and issue types, changes combined schema
14→15 and health 12→13, and changes security sink wording; successful coverage
changes schema 2→3. Similar status embedding semantics changed 1→2. The 3.42
model-backed flow has not been certified and is not in the current report baseline.
The 3.43.1 capture adds `constant-parameter`, optional flags, and dead-code
schema 11; security adds a diagnostic and stable finding identity. Audit schema
14 retains the inherited/new and brief-verdict contracts in the synthetic cases.

## Upgrade and runner assessment

The upstream [3.43.0](https://github.com/fallow-rs/fallow/releases/tag/v3.43.0)
release separates both companions, selects Linux packages by libc, changes audit
attribution and introduces opt-in diagnostics. The [3.43.1 release](https://github.com/fallow-rs/fallow/releases/tag/v3.43.1)
fixes its Linux GitHub Action installation regression and dead-code/audit false
positives. This repository uses npm installation, not the Fallow Action; normal
host-local `npm ci` does not cross-install a different Linux libc. No concrete
Ubuntu 26 incompatibility was found in the CI, CodeQL or release workflows, so
runner labels remain unchanged. Hosted post-migration CI, CodeQL and release
validation are still needed; local macOS evidence does not certify Ubuntu 26.

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
`capabilities-3.43.1.json` extends that frozen projection with the issue-type
id/command/result-key registry plus related-schema commands and MCP resource
URIs used by `/fallow compatibility`. Runtime mutation tests distinguish additive
unknown capabilities from removed/incompatible modeled capabilities and enforce
bounded transcript-facing diagnostics. The packaged comparison baseline is the
smaller `extensions/fallow/certified-capabilities.ts` projection; both versions
must match the pinned development target. The frozen capability projection has
SHA-256 `8c32fff3d97a339e34bd5eaef481db0eae1cb7cd3ec74a065326a46c7088501e`.

No schema probing or version gate is added to startup, autocomplete, or ordinary
runtime execution. `/fallow compatibility` is the only explicit capability probe,
uses a read-only non-installing runner, and never blocks commands. Independently
installed older/newer Fallow versions remain usable whenever their command paths
still work.

## Captured report and nested-command evidence

`reports-3.43.1.json` contains twelve real CLI JSON reports and four projected
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
node scripts/audit-certification.mjs --write
npm test
npm run smoke:fallow
```

The capture script verifies the pinned CLI version, creates and finally removes
an isolated temporary project/home/config/cache, and inherits neither Fallow
cloud/model overrides nor credentials. Its PATH contains only the repository's
pinned executables and the running Node directory. It never runs setup, cache
clear, fixes, or successful model inference. The same-version type-aware and
Similar Code development companions are installed explicitly because Fallow 3.43
no longer installs them automatically. No model or other optional companion
installation is attempted. Signature verification by the npm executable wrapper
may use its existing package-local verification marker.

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

`coverage-report-3.42.0.json` is historical evidence, not a 3.43.1 capture.
The hosted lane compares a fresh run with its 3.42 known-field contract after
adjusting only the expected version fields; this is not current-version
certification. No local sidecar run is implied. It is a successful local `coverage analyze` capture
from `coverage-project.json`. Node 24 executes one function under native V8
coverage while leaving one tracked function cold; Fallow 3.42.0 and the signed
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

## Optional model-backed Similar Code evidence

`similar-code-report-3.36.0.json` is historical 3.36 evidence, not a 3.43.1 certification. It preserves three successful specialized report
layouts from `similar-code-project.json`: complete semantic discovery, a
source-grounded inspect packet, and immutable candidate/verdict review. The tiny
project contains two intentionally identical implementations with distinct
export names. The frozen verdict therefore records behavioral equivalence while
conservatively keeping `refactor_safe: false` until export compatibility has an
explicit plan.

The evidence binds the exact Fallow version, model ID/revision/license, project
digest, candidate source digests, candidate/review identities, and exact input
document hashes. It retains model and provider provenance, completion phases,
enrichment availability, diagnostics, actions, and the separate verdict. Only
elapsed/provider timing and telemetry run identity are normalized. Offline tests
exercise all three reports through parsing, normalization, bounded output, and
readable complete-output retention, and mutation-check report identity, model,
source, inspect availability, verdict, and digest drift while allowing additive
fields.

This lane requires the user to have already installed Fallow's exact pinned model.
It never authorizes or invokes setup and cannot download a model. Discovery runs
with an explicit empty config and `--no-cache`; the captured completion contract
must report a disabled cache with zero writes and local-only source processing.
Inspect and review consume temporary copies of the unchanged normalized discovery
and verdict documents. The script isolates project/config state, strips unrelated
environment variables and credentials, and removes all temporary files.

Regenerate deliberately, or compare a fresh local run with the frozen evidence:

```sh
node scripts/similar-code-certification.mjs --write
npm run smoke:fallow-similar
```

Ordinary unit tests are fully offline. This manual lane is intentionally absent
from CI and release gates because automation must not install the model and hosted
runners do not own a user-authorized model cache. A missing, mismatched, or
integrity-unverified model fails with guidance instead of running setup. This
completes #83's model-backed nested workflow evidence; future report additions
should remain evidence-driven rather than claiming exhaustive certification of
every Fallow output layout.

## Audit attribution projection

`audit-projection-3.43.1.json` retains selected fields from real 3.43.1 JSON
audit runs in a temporary Git repository with synthetic files. The base tracked
`index.js` importing `used` from `lib.js`, which also exported `unused`. The
first run appended a comment to `lib.js`; `audit --base HEAD --gate new-only
--only dead-code --format json --quiet --no-cache` returned exit 0, verdict pass,
and one inherited unused export. After appending `export const addedUnused = 3;`,
the same command returned exit 1, verdict fail, with one introduced and one
inherited finding. A `--brief` run returned exit 0 despite its fail verdict.
The projection deliberately omits hashes, timings, diagnostic text and unrelated
fields; it is evidence of these cases, not a complete audit report capture.
`npm run smoke:fallow` recreates this isolated project and compares the live
projection and all three exit codes. Offline regression tests require structured
verdict and attribution rather than counting all findings or trusting brief's exit
status. The 3.42 namespace-member, unlisted-binary and duplicate-alias normalizer
regressions use synthetic mutations, not claims of captured nonempty wire reports.
