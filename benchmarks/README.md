# Token benchmarks

This directory freezes Pi Fallow's model-visible `0.2.0` behavior before token optimizations. Execution, Git, cold/warm, and memory measurements are documented separately in [`PERFORMANCE.md`](./PERFORMANCE.md).

## What is measured

The benchmark records exact token counts for two pinned encodings:

- `o200k_base` — primary comparison encoding
- `cl100k_base` — secondary compatibility signal

It measures four extension-controlled surfaces independently:

1. `tool-contract` — `fallow_run` schema, description, snippet, and prompt guidelines.
2. `tool-result` — content returned to the coding agent by `fallow_run`.
3. `slash-transcript` — model-visible content persisted by `/fallow`.
4. `editor-prompt` — prompts generated from navigator selections.

`raw-report` is retained as a reference. TUI-only rendering and temp-file contents do not count as model context.

Every result also records UTF-8 bytes, characters, lines, finding retention, required-field retention, full-output references, next-turn context tax, and five-turn cumulative context exposure.

## Frozen corpus

`corpus.json` identifies the benchmark version and scenarios. `fixtures/` contains deterministic reports with no, small, medium, and large finding sets plus audit, duplication, health, security, and schema outputs.

The benchmark hashes the manifest and every referenced fixture. Results with different benchmark versions, corpus hashes, primary encodings, or tokenizer versions cannot be compared.

Do not edit a versioned fixture after collecting a baseline. Create a new benchmark version when the corpus changes.

## Commands

Generate a candidate result. Navigator prompts use the default compact detail mode:

```bash
npm run bench:tokens -- \
  --label candidate \
  --output /tmp/pi-fallow-token-candidate.json
```

Measure the explicit full-details mode separately with `--prompt-detail full`. Use `--prompt-detail both` for exploratory artifacts containing both modes; do not compare its aggregate prompt total with a single-mode baseline.

```bash
npm run bench:tokens -- \
  --label candidate-full \
  --prompt-detail full \
  --output /tmp/pi-fallow-token-candidate-full.json
```

Compare it with the frozen before state:

```bash
npm run bench:tokens:compare -- \
  benchmarks/baselines/v0.2.0.json \
  /tmp/pi-fallow-token-candidate.json
```

## Immediate baseline before `fallow_run.detail`

[`baselines/v0.4.0-pre-output-detail.json`](./baselines/v0.4.0-pre-output-detail.json) freezes commit `2350b0a5f19abfa51d1fd53fa6abf7d7eb0938da`, immediately before `fallow_run.detail` became effective. Use this baseline for release evidence that isolates the output-detail change from earlier token optimizations:

```bash
npm run bench:tokens -- \
  --label release-candidate \
  --output /tmp/pi-fallow-token-release.json
npm run bench:tokens:compare -- \
  benchmarks/baselines/v0.4.0-pre-output-detail.json \
  /tmp/pi-fallow-token-release.json
```

The post-change measurement at merge commit `c208eb88ef7d7a276ed56e0c150bc4383d43938a` produced:

| Surface/scenario (`o200k_base`) | Before | After | Inline finding retention after |
|---|---:|---:|---:|
| All tool results | 45,104 | 8,046 | bounded per scenario |
| No-findings tool result | 309 | 233 | not applicable |
| 5-finding tool result | 1,064 | 738 | 5/5, 100% required raw-field retention |
| 40-finding tool result | 6,403 | 1,315 | 11/40, 100% required raw-field retention |
| 300-finding tool result | 12,416 | 1,311 | 11/300, 100% required raw-field retention |
| Schema tool result | 11,497 | 173 | not applicable |
| All slash transcripts | 12,645 | 12,645 | unchanged |

This is an **82.16%** aggregate tool-result reduction, not a claim that omitted findings disappeared: bounded results report exact inclusion/omission counts and retain a complete-output reference. The small report remains complete inline, and contract tests separately verify normalized location, evidence, and preferred-action fields.

## `0.2.0` before findings

Primary `o200k_base` measurements:

| Surface/scenario | Tokens | Context including active tool contract |
|---|---:|---:|
| Active `fallow_run` contract | 2,237 | 2,237 on every applicable model request |
| Tool result, no findings | 309 | 2,546 next-turn tokens |
| Tool result, 5 findings | 1,064 | 3,301 next-turn tokens |
| Tool result, 40 findings | 6,403 | 8,640 next-turn tokens |
| Tool result, 300 findings/truncated | 12,416 | 14,653 next-turn tokens |
| Tool result, Fallow schema | 11,497 | 13,734 next-turn tokens |
| Editor prompt, 20 dead-code findings | 4,541 | 6,778 next-turn tokens |
| Editor prompt, 20 audit findings | 4,728 | 6,965 next-turn tokens |

Important baseline findings:

- The fixed tool contract costs 2,237 tokens before a Fallow result is included.
- A no-findings result adds 309 tokens, making the isolated next-turn Fallow context contribution 2,546 tokens.
- A medium 40-finding result preserves all benchmark findings and required fields, but contributes 8,640 tokens with the active tool contract.
- The truncated 300-finding result includes 84 complete/partial findings and reaches 14,653 next-turn tokens. It retains a full-output reference.
- `/fallow schema` places 11,497 result tokens in model-visible transcript content despite having no actionable navigator findings.
- Selecting 20 findings creates roughly 4.5–4.7K prompt tokens before accounting for the active tool contract or other conversation context.
- Slash-command navigator summaries intentionally include no raw finding IDs. The baseline records this rather than treating a small summary as equivalent to retained actionable detail.

These values are deterministic corpus measurements, not universal provider billing. Provider-specific wrappers and prompt caching can change billed input/cache tokens, while context-window occupancy remains.
