# Repository Discovery

[한국어](ko/repository-discovery.md)

## Repository Evidence Index (Development)

Full QA JSON now adds `repositoryIndex` and `repositoryImpact`. The index reads
the Git inventory before choosing relevant metadata. Supported JS/TS files use
the TypeScript syntax parser; this is not type checking or code execution.
Declarations, named and namespace imports, reexports, lexical references, test
locations, registration candidates, package entry declarations, compiler aliases,
OpenAPI operation/response pointers, and validation-script hashes are reusable
blocks. Unsupported syntax, languages, malformed documents and bounded omissions
remain visible in `coverage.skipped`.

`repositoryIndex.reuse` separates content reads (`readFiles`, `readBytes`) from
syntax work (`reusedFiles`, `rebuiltFiles`). Warm refreshes still read and hash
supported files. Changed blocks rebuild; relationships are recomputed through
previous and current imports. Configuration changes invalidate import-bearing
relationships without discarding unchanged syntax. These counters describe one
index refresh, not all work performed by the CLI or an LLM.

`repositoryImpact.paths` traces changed declarations through exact aliases,
declared package entries and reexports to test references or registration
candidates. An unused importer is not an affected product flow. Namespace access
must identify the referenced export. Multiple resolvable package conditions,
dynamic module loading, unrecognized declarations and traversal limits are
boundaries for focused review. A registration-shaped call is only a candidate,
not proof that a framework registered a route. Every path is a `draft` and
execution remains `not-run`.

The repository index uses the workspace root during explicit or automatic package
QA. Its paths remain workspace-relative even when existing QA evidence is
package-relative. It describes **current working-tree files**, not a reconstructed
historical checkout. Committed-only QA with a different source/configuration tree
returns `repository-snapshot-mismatch` instead of citing current-file lines as
historical evidence. Working-tree analysis may trace the current index directly.

The separate `qamap-repository-index-<user-id>` cache shares the private storage
rules below: 8 MiB per snapshot, at most eight retained repositories after a
successful write, 24-hour expiry, and fail-open rebuilding. It stores structural
metadata and hashes, not source bodies, test descriptions, command bodies or
response examples. Names, module specifiers and schema pointers can still expose
repository structure. Disable it with `QAMAP_REPOSITORY_CACHE=off`. The existing
import cache is independently controlled by `QAMAP_IMPORT_CACHE=off`.

The compact `repository` handoff retains index identity, coverage counts, an
affected test path and targeted uncertainty. Its recovery file contains all
indexed blocks and complete bounded impact paths. "Complete" recovery means no
additional summary truncation; analyzer limits and unsupported evidence still
apply. See [agent format](agent-format.md).

QAMap's import graph starts with Git-tracked paths and non-ignored untracked
paths in the selected directory. Ignored untracked paths are not searched. When
Git confirms that the directory is not a repository, a filesystem walk with fixed
directory exclusions is used and labeled as such. This fallback does not interpret
Git ignore files. Missing Git, other Git errors, or a truncated inventory do not
silently fall back to a broader scan.

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
| `parsedSources` | Readable JS/TS/Vue/Svelte sources represented by parsed or reused import blocks. Not proven runtime relationships. |
| `skipped` | Exact relative paths and bounded reasons for exclusions or missing evidence. |
| `limits` | Source count, file size, package count, and default graph traversal limits. |
| `fingerprint` | Content-derived identity of the discovery inputs and policy, without timestamps or absolute paths. |

Typical skip reasons are `source-limit`, `oversized`, `binary`, `symlink`,
`nested-repository`, `unreadable`, `unsupported-language`, `non-source`, and
`excluded-directory`. Files past the 12,000-source limit remain in the inventory
and are explicitly marked `source-limit`; they do not disappear from the receipt.

Source content is not copied into this receipt. Paths may still reveal repository
structure, so keep reports from private repositories private.

## Import Index Reuse

Supported source files are read and content-hashed on every refresh. Unchanged
files reuse their resolved import blocks, including across separate processes.
Changed files are parsed again. Candidate-path, alias, or workspace-package
configuration changes conservatively rebuild all import resolutions. Reverse
edges are always assembled again from the current blocks.

Full QA JSON also includes `importIndexReuse` for the **last import-index refresh**,
not aggregate work across the entire command. Other QA stages may have already
warmed the cache. These operational counters do not change `importDiscovery` or
its fingerprint, and are not added to the compact agent context.

| Field | Meaning |
| --- | --- |
| `status` | `cold`, `warm`, `incremental`, `rebuilt`, `disabled`, or `unavailable`. |
| `storage` | `saved`, `unchanged`, `skipped`, or `failed`; analysis still succeeds without cache storage. |
| `reusedSources` / `rebuiltSources` | Reused and freshly parsed source blocks in this refresh. |
| `hasBaseline` | Whether a valid previous snapshot was available for comparison. |
| `changedSources` | Added, removed, or content-changed blocks since that snapshot. Empty without a baseline. |
| `affectedImporters` | Transitive importers reached through previous and current edges. Configuration changes conservatively include import-bearing files. This is not proof of affected runtime behavior. |
| `reason` | Why rebuilding was needed, such as `invalid-cache`, `expired-cache`, or `resolution-context-changed`. |

The cache is local to the operating system's temporary directory under
`qamap-import-index-<user-id>` (a hashed user identifier on platforms without a
numeric user ID). It stores relative file paths, content hashes, and resolved
relative imports, not source bodies or raw import strings. Directory and file
permissions are user-only where supported. Symlinks, shared locations, and cache
directories inside the analyzed repository are rejected.

Each snapshot is limited to 8 MiB. Successful writes prune managed snapshots to
eight repositories and remove managed files older than 24 hours. Concurrent writes
can temporarily exceed that count; interrupted temporary writes are also eligible
for age-based cleanup. There is no background cleanup process. You may delete the
cache directory at any time. Corrupt, expired, or incompatible snapshots are
discarded; missing or failing Git discovery never serves old cached evidence.

Disable persistence for a command:

```sh
QAMAP_IMPORT_CACHE=off qamap qa --format json
```

The import-graph module also accepts `{ cacheDirectory: false }` or an explicit
private directory outside the analyzed repository. This index covers imports
only, not all QA evidence. It avoids repeated parsing and resolution, **not all
file reads**, and does not establish an LLM token-savings claim.

## What This Does Not Prove

- The inventory is not an exhaustive behavior model. Dynamic wiring, unsupported
  languages, and unresolved imports still need focused inspection.
- Git discovery includes current untracked work but excludes ignored untracked
  paths. It does not inspect submodule contents or follow symbolic links.
- The legacy import receipt follows package scope. The new repository index uses
  the supplied workspace root; neither receipt proves semantic completeness.
- `qa` does not modify the analyzed repository and remains `not-run`. No
  dependencies are installed and no product tests are executed. The disposable
  import cache is stored separately, as described above.
- Neither index establishes full-repository QA coverage or provider token savings.

## Verification

`test/import-discovery.test.mjs` covers a Git inventory beyond 2,000 paths,
explicit 12,000-source truncation, ignored files, source-size and binary limits,
symlink boundaries, non-repository fallback, missing or failing Git, package
capacity, in-process edits and deletions, configuration changes, and static QA
output.

`test/import-index-cache.test.mjs` checks separate-process reuse, content and
configuration invalidation, transitive importers and cycles, unsafe or corrupt
storage, concurrent writes, retention, and disabled-cache parity. Its 2,005-source
fixture compares uncached, cold, warm, and incremental graphs and fingerprints.
Timings are diagnostic samples, not speed guarantees or token measurements:

```sh
pnpm build
node --test --test-name-pattern="large import inventory" test/import-index-cache.test.mjs
```
