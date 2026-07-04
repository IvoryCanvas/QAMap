# Benchmarking QAMap

`scripts/bench.mjs` scores QAMap's plan/qa output against a fixed set of repositories with pinned commits, so heuristic changes can be judged by numbers instead of feel. The runner is read-only against every target.

## Setup

1. Copy `bench.config.example.json` to `bench.config.local.json` (gitignored).
2. Point each target at a local repository checkout, pin `base`/`head` commit SHAs, and optionally declare expectations:
   - `expect.runner` — the runner a human would pick for this repo (`playwright`, `maestro`, `manual`).
   - `expect.mustReachFiles` — files a human QA would name for this diff window; recall against generated flows is reported.
   - `expect.mustNameFlows` — substrings that should appear in at least one flow title.

## Run

```sh
pnpm bench                      # table only
node scripts/bench.mjs --save   # also writes bench-results/<timestamp>.json
node scripts/bench.mjs --baseline bench-results/<file>.json   # delta vs a saved run
```

## Metrics

- `runner` mismatch lines — wrong tool recommendation for a known repo shape.
- `viaImport` — flows produced through the reverse import graph (shared-file changes reaching surfaces).
- `blank` — steps with blank action slots (must stay 0).
- `generic` — flows with content-free names (`... primary journey`, `... smoke flow`); lower is better.
- `reach` — recall of `mustReachFiles`; missing files are listed per target.
- `agentBytes` — size of the `--format agent` payload.

Re-run with `--baseline` before merging heuristic changes; a PR that moves these numbers should say so in its body.
