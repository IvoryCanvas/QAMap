# Claude Directory Submission

For release preparation, `pnpm release:prepare --version X.Y.Z --date YYYY-MM-DD`
refreshes shared policies and required CLI pins. Use `--claude-version X.Y.Z`
when the Claude plugin revision differs from the CLI release. `pnpm plugin:bundle` generates
an inspection ZIP and copyable source/data-handling fields. The
[review preparation guide](plugin-review-preparation.md) links the management
portal and the source-folder shortcut that fills the branch and path.
Submit the Git source, not this inspection ZIP, and validate the displayed
commit after the release PR is merged.

For installation and first-use consent, read the [Claude Code setup guide](claude-code.md)
([한국어](ko/claude-code.md)). This document is for maintainers.

## Current Status

The management portal showed the plugin as published on 2026-10-02, with
Claude Code as its only selected surface. On 2026-10-13, version 0.5.2 from
commit `575ce12` passed the portal checks and was published with
**Publish update**. Approval, publication and a successful
user installation are distinct evidence. The portal establishes publication;
the public listing establishes the served version. Local tests or a matching
npm version cannot establish either. The shown automatic-publication toggle was
off, so later versions must follow the portal's applied publication policy.

For an approved version that is not live, follow the portal's Publish action and
applied publication policy. Do not withdraw and resubmit an approved plugin just
to refresh documentation. Preserve the last live version during later reviews.

## Submission Source

Submit the dedicated plugin folder, not the repository root. The root includes
development benchmarks, test fixtures and release tooling that are not part of
the installed skill. The directory's source scanner can inspect those files
when the plugin path is left blank.

## Source Fields

| Field | Value |
| --- | --- |
| Repository | `https://github.com/IvoryCanvas/QAMap` |
| Plugin path | `plugins/claude` |
| Branch or tag | `main` |

The plugin path names the folder containing `.claude-plugin`, not the manifest
file itself. Re-validate the source and check the displayed commit before
continuing. For a version-pinned submission, `v0.5.2` is the first release tag
that includes `plugins/claude` and can be used with this path. The existing
`v0.5.1` tag predates the folder;
do not move that tag or use it with this path.

Tracking `main` allows subsequent commits on that branch to be picked up by the
directory. It does not mean changes bypass review or become publicly available
immediately. Review and publication remain separate from npm and OpenAI.
The scheduled check and an optional GitHub push webhook discover updates;
auto-publication depends on the setting applied by the reviewer. Review the
displayed source revision after each change. A README update does not publish
a new CLI version or move the existing `v0.5.1` tag.

## What Is Included

The folder contains nine files: its own manifest and analysis-only skill, the
square SVG icon, a README, and five license, support and policy files.
It has no package manifest, lockfile, development scripts, test fixtures, hooks
or MCP server. The QAMap CLI is installed separately with the user's permission.

The skill runs a consented brief and targeted evidence reads. It stops after
findings, suggested verification and unknowns. Report recommendations do not
authorize project commands, E2E generation, preference changes or manifest repair.
Those features remain available through the separate CLI, outside this plugin.
There is no advanced execution guide in the installed Claude bundle and no
delegation to one. Local reports and analysis caches are still written; this is
not a claim that analysis performs no filesystem writes or a sandbox around the CLI.

Installation is a separate user task and downloads npm packages. The caller
still uses model tokens when interpreting the local report.

## Keep The Folder Current

Edit the Claude-specific manifest, skill and README in `plugins/claude` directly.
The root portable skill and legacy manifest remain separate and follow the CLI
release. Refresh only the shared icon and policy copies with the command below.
Update the required CLI pin when preparing a CLI release; bump the Claude
manifest version for every Claude plugin release, including plugin-only changes.

```sh
node scripts/directory-plugin.mjs --write
pnpm plugin:check
node --test test/directory-plugin.test.mjs
claude plugin validate plugins/claude
```

The normal CI plugin check rejects extra files, symbolic links, oversized files,
missing icons, invalid versions, stale CLI pins and drift from the shared policies.
It preserves the Claude-specific skill instead of restoring the portable execution guide.
The npm smoke also checks that this directory-only copy stays out of the npm
package. Do not add ignore rules to conceal files from the directory scanner.

Claude Code 2.1.247 recognizes `displayName` but warns that the four directory
link fields listed below are unknown and ignores them at runtime. The submission
portal reads those fields. Local validation passes with these four warnings;
`--strict` fails because it treats warnings as errors. Inspect the reported
fields rather than treating other validation warnings as expected.

Local validation and an isolated installation verify packaging, not directory
approval. Review any remaining portal warnings and policy holds on their
individual merits. A policy hold requires reviewer attention; it is not proof
of credential disclosure or a final rejection. Do not mark a credential as
required merely because unrelated development files triggered an earlier scan.

## Submission Details

### 0.5.3 Analysis-Only Update

On 2026-11-09, the owner reported that the analysis-only source `36ec0c0`
passed directory policy and security scanning and that Publish update had been
requested. The release version is 0.5.3. This update retains that analysis-only
workflow and restores the plugin manifest and README to 0.5.3. Version changes
require an explicit maintainer instruction.

The owner supplied another policy hold for `9b9e56e` on 2026-11-08, so the
earlier launcher removal did not resolve the reported finding. The classifier's
exact credential flow remains unconfirmed. The CLI's optional project executor
inherits its process environment; that is a real reason not to describe every
CLI execution path as credential-free, even though local analysis needs no key.

Claude plugin 0.5.3 requires the already published CLI 0.5.3. It narrows the
plugin's actual workflow to PR analysis: remove the advanced execution reference
and its skill links, prohibit following executable next actions, and stop for
requests to run project commands, generate automation or change configuration.
The portable CLI/OpenAI skill retains its existing scope. The native Claude
manifest, README, archive and generated field sheet disclose this distinction.
This is a workflow restriction, not an operating-system execution sandbox.

After the PR is merged to the tracked `main`, open the existing submission and
select **Check for new commits**. Verify the displayed commit and plugin 0.5.3;
do not create a duplicate submission or select a new repository to escape a hold.
`Resubmit for review` applies only if the submission has been rejected. Stop at
the recheck handoff unless the owner separately asks to request review or publish.
Local validation does not prove the directory hold has cleared; a new version
can still require an Anthropic reviewer.

### 0.5.3 Credential Policy Hold

On 2026-11-06 the owner supplied a directory report for source `9f36a02`:
validation passed with warnings and the security scan passed, but directory
policy held the version under `MCP_FORWARDS_CREDENTIAL_ENV`. It cited the shared
advanced workflow and the manifest. This is a hold, not a confirmed credential
disclosure or a final rejection. The existing live version continues serving.

Neither cited file declares an MCP server, credential environment variable,
credential file read or authenticated endpoint. The advanced workflow did offer
package-manager launchers; they can consult the user's package-manager settings.
That was a possible source of the finding, not a confirmed explanation of the
directory's classifier. The `9b9e56e` change removed those launcher commands
and keeps installation outside the installed skill. Advanced commands use the
existing CLI and stop when setup is missing. Credential discovery is explicitly
excluded; service setup for a separately requested project command stays with
the user. This changes the workflow, rather than concealing an active install.

Keep `documentationUrl`, `privacyPolicyUrl`, `supportUrl` and `termsOfServiceUrl`:
the supplied report says the directory reads them and no action is needed.
Do not add an unused `userConfig` secret field to a plugin with no authenticated
service. If a future component actually needs a credential, implement the
directory's explicit user-supplied configuration contract for that component.

After this source is merged, use the existing submission's update/revalidation
flow and check the displayed commit. Local tests cannot establish that the hold
has cleared. If it persists, give the reviewer the cited file contents, the
absence of MCP/hook/env credential declarations and the exact new commit; the
reviewer must resolve the finding. Do not withdraw the live listing or claim
approval merely because the package validates locally.

The manifest sets `displayName` to `QAMap` while keeping the installation name
`qamap`. Its `privacyPolicyUrl`, `termsOfServiceUrl`, `supportUrl` and
`documentationUrl` point directly to the maintained public documents. After
changing these fields, re-validate the source and check the name and links in
Listing details; marking a section "Looks right" does not refresh its contents.

Select only Claude Code under Listed on until the workflow has been tested on
the other surfaces. The skill requires access to a local checkout and terminal;
the presence of a listing is not proof of execution support in every app.

Use the current manifest's version and description. For data handling, explain
that the plugin reads the selected local repository, writes local reports and
returns evidence to Claude. Reports can contain source excerpts and data already
in that repository. The local analysis engine does not call a model or upload
source; Claude's handling of the returned content is governed by the host.

No provider API key is required by the plugin. Developer-only paid model
benchmarks are not included. Separate CLI installation and project commands can
have network access and must not be described as plugin analysis.

Official references: [submission steps](https://claude.com/docs/plugins/submit)
and [pre-submission checks](https://claude.com/docs/plugins/pre-submission-checklist).
