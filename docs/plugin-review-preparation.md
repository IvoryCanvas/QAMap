# Plugin Review Preparation

The same release has three independent deliveries: npm, OpenAI and Claude.
Generated files contain public metadata, not developer credentials, legal
attestations or claims that reviewers have executed the supplied examples.

## Generate

```sh
pnpm plugin:check
pnpm plugin:bundle
```

The ignored `release-artifacts/` directory receives versioned OpenAI and Claude
ZIPs, a reviewer guide, a submission-fields JSON and `SHA256SUMS`. The ZIPs use
stable file order and timestamps, so unchanged inputs produce identical bytes.
They include skills, branding and policies, not runtime dependencies, benchmark
implementations, test fixtures, local logs or publishing configuration.

Run again from the clean final release commit. A dirty guide identifies
uncommitted inputs; a packaging success does not imply readiness to submit.
The guide's public fixture URLs point to its recorded commit. The field sheet
contains five positive and three negative review instructions and honest data
handling copy; these are not host-execution results.

## Portals And Source Fields

| Purpose | URL or value |
| --- | --- |
| OpenAI management | https://platform.openai.com/plugins |
| Existing OpenAI listing | https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629 |
| Claude management | https://claude.ai/directory/manage |
| Claude source shortcut | https://github.com/IvoryCanvas/QAMap/tree/main/plugins/claude |
| Claude repository | https://github.com/IvoryCanvas/QAMap |
| Claude plugin path | `plugins/claude` |
| Claude tracked branch | `main` |
| npm package | https://www.npmjs.com/package/@ivorycanvas/qamap |
| Release history | https://github.com/IvoryCanvas/QAMap/releases |
| Privacy | https://github.com/IvoryCanvas/QAMap/blob/main/PRIVACY.md |
| Terms | https://github.com/IvoryCanvas/QAMap/blob/main/TERMS.md |
| Support | https://github.com/IvoryCanvas/QAMap/issues/new/choose |

For Claude, use the existing submission. Pasting the source shortcut lets the
portal fill the folder and branch; revalidate and inspect the displayed commit
after the release PR is merged. The Claude ZIP is for offline inspection,
not the submission source. A new tag URL works only after its tag exists.

## What Fills Automatically

| Channel | Generated package/source fields | Owner completes |
| --- | --- | --- |
| OpenAI | Listing text, links, icons, prompts, `requires_local_executor`, `extensions.com.openai.publication.release_notes` | Developer identity, owning organization, portal findings, applicable attestations and submit/publish |
| Claude | Name, version, description, privacy/terms/support/documentation URLs and README | Data handling answers, contact email, Claude Code surface, acknowledgements and submit/publish |

The OpenAI manifest stays in the supported `.codex-plugin/plugin.json` format.
Its local-executor flag describes the required local shell and checkout.
Skills-only plugins do not require MCP review cases or a demo recording; do
not invent a server or upload these examples as MCP scan results. If the portal
rejects local-executor eligibility or skills-only updates, preserve the live
version and resolve the reported access/policy issue with OpenAI. Package
validation cannot bypass that policy. The earlier 0.5.2 refusal is historical,
not a fresh finding about this package.

The manifests do not set country availability, private reviewer accounts or
auto-publication. Those require the owner's existing account settings and
decisions; generated metadata must not silently replace them.

## Before Either Submission

1. Publish the exact CLI version after its release gates pass.
2. Run `node scripts/release-smoke.mjs --version X.Y.Z` against public npm.
3. Rebuild from the final clean commit and verify the hashes.
4. Open the existing submissions; upload the OpenAI ZIP and validate Claude's
   Git source. Confirm the imported version, links and scan results.
5. Submit the replacement for review; preserve the current live version until
   the replacement is approved and published.

Official requirements checked 2026-11-06:
[OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[desktop-only declaration](https://developers.openai.com/plugins/deploy/desktop-only),
[Claude submission](https://claude.com/docs/plugins/submit),
[Claude checks](https://claude.com/docs/plugins/pre-submission-checklist).
