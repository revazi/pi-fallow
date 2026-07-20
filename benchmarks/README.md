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

Generate a candidate result:

```bash
npm run bench:tokens -- \
  --label candidate \
  --output /tmp/pi-fallow-token-candidate.json
```

Compare it with the frozen before state:

```bash
npm run bench:tokens:compare -- \
  benchmarks/baselines/v0.2.0.json \
  /tmp/pi-fallow-token-candidate.json
```

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
