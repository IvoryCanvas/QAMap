# QAMap Privacy Notice

Effective date: September 8, 2026

QAMap is an open-source, local-first command-line tool. This notice explains what the QAMap CLI and its packaged agent skill read, write, and transmit.

## Data QAMap Reads

QAMap can read the repository where you run it, including:

- Git commits, branches, and diffs
- source files and repository structure
- package scripts and test configuration
- existing tests, selectors, fixtures, and optional `.qamap` configuration

QAMap uses this material to infer changed behavior, route QA scenarios, cite evidence, and prepare optional validation or automation handoffs.

## Default Data Handling

`qamap qa` performs local static analysis. QAMap does not operate a hosted analysis service, upload repository source, or include product analytics or telemetry.

The compact agent format can write one recovery report to the operating system's temporary directory so an agent can inspect evidence omitted by compaction. QAMap creates this file with user-only permissions where the operating system supports them and removes stale QAMap recovery reports during later agent-format runs. The analyzed repository is not modified by this behavior.

Import analysis can also store disposable snapshots in a user-specific `qamap-import-index-*` directory under the operating system's temporary directory. These contain relative file paths, content hashes, and resolved relative import relationships, not source bodies or raw import strings. Paths can still reveal repository structure. These snapshots stay local and use user-only permissions where supported. Set `QAMAP_IMPORT_CACHE=off` to disable import-cache reads and writes.

The repository evidence index uses a separate `qamap-repository-index-*` directory
with the same storage and retention rules. It stores declaration names, static
module specifiers, import/export bindings, reference and test locations, schema
pointers, validation-script names and content hashes. It does not persist source
bodies, test descriptions, command bodies or response examples. This metadata can
still identify private repository structure. Set `QAMAP_REPOSITORY_CACHE=off` to
disable repository-index persistence. Both indexes still read and hash supported
files when refreshing; disabling persistence does not disable local analysis.

## Network Access

The QAMap analysis engine does not require an OpenAI API call or another LLM call.

Network access can still occur outside the analysis engine:

- a package manager may contact the npm registry to install QAMap
- a coding-agent host may process prompts and QAMap output under that host's own privacy terms
- `qamap qa run` can execute an existing repository command that has its own network or data behavior
- user-configured CI, GitHub, package-manager, or test integrations follow their respective policies

The skills-only QAMap plugin does not add an MCP server or a separate QAMap cloud service.

## Files QAMap Writes

Plain `qamap qa` does not write to the analyzed repository. QAMap writes repository files only through an explicit command or option, including:

- `manifest init`, `history init`, or an explicit `--output` or `--write`
- `init --agent` or `init --scripts`
- `e2e draft` without `--dry-run`
- a repository validation command selected and explicitly run through `qa run`

Local history remains in the user's repository and is ignored by Git by default. Users control its retention and deletion.

## Retention And Control

QAMap has no server-side repository-data retention because it has no hosted analysis service. Repository files remain under the user's control. Temporary recovery reports are local to the machine and are eligible for automatic cleanup after 24 hours.

Import snapshots are limited to 8 MiB each. Successful writes prune managed snapshots to eight repositories and remove managed files older than 24 hours, including abandoned temporary writes. Concurrent writers can temporarily exceed the count. Cleanup runs on later writes, not on a background timer. You may remove the import-cache directory at any time without losing repository work.

You can inspect all QAMap behavior in the public source repository and remove local QAMap files at any time.

## Contact

For privacy questions, open a support request through [GitHub Issues](https://github.com/IvoryCanvas/QAMap/issues/new/choose). Do not include private source code, credentials, personal data, or customer data in a public issue.
