# Repository Discovery

[한국어](ko/repository-discovery.md)

QAMap's import graph starts with Git-tracked paths and non-ignored untracked
paths in the selected directory. Ignored build output is not searched. Without
Git metadata, a filesystem walk is used and labeled as such. A Git error or
truncated inventory does not silently fall back to a broader scan.

## Read The Receipt

`qamap qa --format json` includes `importDiscovery`. Markdown and text output
show a short summary.

| Field | Meaning |
| --- | --- |
| `scope` | `import-graph`, not the coverage of every QAMap analyzer. |
| `snapshot` | `working-tree`; this graph reads current files, not a historical checkout. |
| `discovery` | `git`, `filesystem`, or `unavailable`. |
| `inventoryComplete` | Whether path enumeration completed within the selected directory and discovery policy. Not semantic completeness. |
| `inventoryFiles` | Number of enumerated file paths, including paths excluded from import parsing. |
| `parsedSources` | Files inspected by the static JS/TS/Vue/Svelte import parser. Not proven runtime relationships. |
| `skipped` | Exact relative paths and bounded reasons for exclusions or missing evidence. |
| `limits` | Source count, file size, package count, and default graph traversal limits. |
| `fingerprint` | Content-derived identity of the discovery inputs and policy, without timestamps or absolute paths. |

Typical skip reasons are `source-limit`, `oversized`, `binary`, `symlink`,
`nested-repository`, `unreadable`, `unsupported-language`, `non-source`, and
`excluded-directory`. Files past the 12,000-source limit remain in the inventory
and are explicitly marked `source-limit`; they do not disappear from the receipt.

Source content is not copied into this receipt. Paths may still reveal repository
structure, so keep reports from private repositories private.

## What This Does Not Prove

- The inventory is not an exhaustive behavior model. Dynamic wiring, unsupported
  languages, and unresolved imports still need focused inspection.
- Git discovery includes current untracked work but excludes ignored untracked
  paths. It does not inspect submodule contents or follow symbolic links.
- A scoped package receipt does not cover the rest of a monorepo.
- `qa` remains read-only and `not-run`. No dependencies are installed, no product
  tests are executed, and no persistent cache is written by discovery.
- Repeated calls refresh changed files and import configuration. Persistent
  incremental reuse and repository-first compact agent output are separate work;
  this receipt makes no token-savings claim.

## Verification

`test/import-discovery.test.mjs` covers a Git inventory beyond 2,000 paths,
explicit 12,000-source truncation, ignored files, source-size and binary limits,
symlink boundaries, fallback discovery, in-process edits and deletions,
configuration changes, and static QA output.
