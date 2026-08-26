# QAMap Documentation

**English** | [한국어](ko/README.md)

You do not need to read every QAMap document. Pick the shortest path that matches
what you are trying to do.

## Start Here

| You want to | Read |
| --- | --- |
| Run QAMap once and understand the result | [First-run walkthrough](quickstart-demo.md) |
| Adopt it in daily work or CI | [Adoption guide](adoption.md) |
| Look up a command or output format | [Command reference](commands.md) |
| Use it from a coding agent | [Agent integration](agent-skill.md) |
| Report a problem or contribute | [Contributing](../CONTRIBUTING.md) |

## Configure Only When Needed

The first run does not require configuration.

| Need | Read |
| --- | --- |
| Change CLI defaults or output paths | [Configuration](configuration.md) |
| Preserve reviewed QA context in the repository | [Verification manifest](manifest.md) |
| Add context to one important symbol | [Symbol annotations](symbol-annotations.md) |
| Validate a PR description against changed behavior | [Verification](verify.md) |

## Automation And Integrations

| Integration | Read |
| --- | --- |
| Compact agent JSON contract | [Agent format](agent-format.md) |
| OpenAI skills-only plugin | [Plugin submission](plugin-submission.md) |
| GitHub Actions and PR comments | [GitHub Action](github-action.md) |
| Generated E2E and checklist examples | [E2E output examples](e2e-output-examples.md) |
| Domain-neutral adoption boundaries | [Ecosystem](ecosystem.md) |

## Internals And Evidence

These are reference documents for maintainers and contributors. They are not
required for a first run.

| Topic | Read |
| --- | --- |
| Behavior graph, routing, and safety boundaries | [Architecture](architecture.md) |
| Public inference and execution fixtures | [Benchmarking](benchmarking.md) |
| Scanner behavior and rule IDs | [Rules](rules.md) and [Guardrails](guardrails.md) |
| Public API surface | [API contracts](api-contracts.md) |
| Evaluation scoring | [Evaluation](eval.md) |
| Current direction | [Roadmap](roadmap.md) |

## Maintainer Guides

| Task | Read |
| --- | --- |
| Open and maintain public issues | [Issue conventions](issues.md) |
| Reuse or update public brand assets | [Brand assets](../brand/README.md) |
| Prepare an npm and GitHub release | [Release runbook](releasing.md) |
| Review current and historical release evidence | [Release validation](release-validation.md) |

## Reading Long Reference Pages

- **Command reference:** start with `Quick Commands`; search for one command
  name instead of reading front to back.
- **Manifest:** stop after `Concrete Bootstrap Example` unless you are defining
  advanced fields.
- **E2E examples:** choose the one repository type that resembles yours.
- **Release validation:** the first version section is current; older sections
  are historical evidence.
