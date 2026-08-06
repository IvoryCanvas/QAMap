# OpenAI Plugin Submission

QAMap packages one `skills-only` plugin for the shared OpenAI Plugins Directory. It reuses the same local CLI and `qamap.qa` contract as every other QAMap integration. It does not add an MCP server, hosted service, background hook, or second QA engine.

The source package is a submission candidate. It is not an approved or publicly listed OpenAI plugin until OpenAI accepts it.

## Product Boundary

- The first action is the read-only `qamap qa --format agent` analysis.
- QAMap reads the checked-out repository locally and does not upload source code.
- QAMap does not make an additional LLM request. The calling OpenAI product still uses its own model tokens to invoke the skill and interpret the result.
- A one-off invocation may download the pinned npm package. The skill discloses that network action and follows the host approval policy.
- Repository command execution, dependency changes, generated test files, and commits remain separate actions with explicit approval requirements.
- The plugin is intended for an OpenAI surface that can access a checked-out repository and local shell. A web-only chat without repository access cannot perform this workflow.

## Submission Sources

| Artifact | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Plugin discovery and listing metadata |
| `skills/qamap-pr-qa/SKILL.md` | The single agent workflow |
| `skills/qamap-pr-qa/agents/openai.yaml` | Skill presentation and invocation metadata |
| `plugin/submission.json` | Listing copy, starter prompts, and evaluation cases |
| `PRIVACY.md` | Local data and network boundaries |
| `TERMS.md` | Usage terms and warranty boundary |
| `SUPPORT.md` | Public support and security routes |

The submission contract contains five positive cases and three negative cases. Positive cases cover web, testless, API, mobile, and repository-command changes. Negative cases protect against unrelated invocation, fabricated green results, and unapproved side effects.

## Local Gates

Run:

```sh
pnpm plugin:check
pnpm plugin:smoke
```

`plugin:check` verifies version alignment, listing fields, legal URLs, prompt limits, icon dimensions, skill metadata, pinned package use, and the evaluation corpus.

`plugin:smoke` builds an npm tarball, checks the packaged plugin files, installs it into an isolated temporary project with no user npm configuration, and runs the installed QAMap binary against a committed public benchmark. It requires a compact `qamap.qa` result with change intent, scenarios, exact diff evidence, one next action, and `execution: not-run`.

The repository CI and `release:check` run both gates.

## Maintainer Submission Sequence

1. Complete the normal QAMap release gate and publish the exact package version referenced by the skill.
2. Run a fresh public-registry install and agent-format smoke against that published version.
3. Confirm the submitting OpenAI account has completed identity verification and has Apps Management write permission.
4. Open the [OpenAI plugin submission portal](https://platform.openai.com/plugins) and create a skills-only submission.
5. Use `plugin/submission.json` as the source of truth for listing copy, starter prompts, and the five positive and three negative evaluations.
6. Upload the canonical logo from `skills/qamap-pr-qa/assets/qamap-logo.png`.
7. Review every requested permission and test receipt before submitting.
8. Do not announce directory availability until the listing is approved and visible.

See the official [Plugins overview](https://developers.openai.com/plugins/) and [submission guide](https://developers.openai.com/plugins/deploy/submission) for current platform requirements.
