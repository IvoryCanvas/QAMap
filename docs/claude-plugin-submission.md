# Claude Directory Submission

Submit the dedicated plugin folder, not the repository root. The root includes
development benchmarks, test fixtures and release tooling that are not part of
the installed skill. The directory's source scanner can inspect those files
when the plugin path is left blank.

## Source Fields

| Field | Value |
| --- | --- |
| Repository | `https://github.com/IvoryCanvas/QAMap` |
| Plugin path | `plugins/claude` |
| Branch or tag | `main`, after the packaging change is merged |

The plugin path names the folder containing `.claude-plugin`, not the manifest
file itself. Re-validate the source and check the displayed commit before
continuing. For a version-pinned submission, use a future release tag that
actually includes this folder. The existing `v0.5.1` tag predates the folder;
do not move that tag or use it with this path.

Tracking `main` allows subsequent commits on that branch to be picked up by the
directory. It does not mean changes bypass review or become publicly available
immediately. Review and publication remain separate from npm and OpenAI.

## What Is Included

The folder contains ten files: the manifest, the square SVG icon, the shared
skill and advanced guide, a README, and five license, support and policy files.
It has no package manifest, lockfile, development scripts, test fixtures, hooks
or MCP server. The QAMap CLI is installed separately with the user's permission.

This is packaging separation, not a claim that downloads never occur. The
README and advanced guide retain the actual version-pinned installation
commands. CLI installation downloads npm packages; the caller still uses model
tokens when interpreting the local report. The skill's consent and execution
boundaries are unchanged.

## Keep The Folder Current

Edit the canonical files at the repository root, then refresh their committed
copies. Update the CLI version in the dedicated README when preparing a release.

```sh
node scripts/directory-plugin.mjs --write
pnpm plugin:check
node --test test/directory-plugin.test.mjs
claude plugin validate --strict plugins/claude
```

The normal CI plugin check rejects extra files, symbolic links, oversized files,
missing icons, version mismatches and drift from the shared skill or policies.
The npm smoke also checks that this directory-only copy stays out of the npm
package. Do not add ignore rules to conceal files from the directory scanner.

Local validation and an isolated installation verify packaging, not directory
approval. Review any remaining portal warnings and policy holds on their
individual merits. A policy hold requires reviewer attention; it is not proof
of credential disclosure or a final rejection. Do not mark a credential as
required merely because unrelated development files triggered an earlier scan.

## Submission Details

Use the current manifest's version and description. For data handling, explain
that the plugin reads the selected local repository, writes local reports and
returns evidence to Claude. Reports can contain source excerpts and data already
in that repository. The local analysis engine does not call a model or upload
source; Claude's handling of the returned content is governed by the host.

No provider API key is required by the plugin. Developer-only paid model
benchmarks are not included. Optional installs or user-approved repository
commands can have network access and must not be described as offline analysis.

Official references: [submission steps](https://claude.com/docs/plugins/submit)
and [pre-submission checks](https://claude.com/docs/plugins/pre-submission-checklist).
