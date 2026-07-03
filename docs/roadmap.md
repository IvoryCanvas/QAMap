# Roadmap

QAMap starts as a local CLI for repo-level AI agent readiness. The project can grow in layers without becoming heavy.

## North Star

QAMap should become a local-first QA skill plus optional QA memory layer: it maps PR changes to affected flows, drafts the E2E/checklist work needed before merge, and improves over time through a repository-level verification manifest. The goal is not to replace reviewers or QA. The goal is to remove the repeated blank-page work that makes developers skip good verification.

The sharp product position is:

```txt
Do not re-prompt AI for the same QA context.
Run a local PR QA draft first, then capture team QA memory in the repo when repeated corrections should improve future recommendations.
```

This means QAMap should be judged less like a generic test recorder and more like a manifest-backed PR verification assistant. A recorder captures what a person just clicked. QAMap should explain what the PR changed, which durable flow/check knowledge applies, and what test artifact should now exist.

## Release Bar

Before treating the next public release as ready, the golden demo must satisfy these conditions:

- First-run output is concrete, not broad: it names the affected feature, flow, draft file, and checks.
- Manifest authoring burden stays low: `manifest context` and `manifest init` provide a useful baseline before a human edits YAML.
- Generated E2E draft is a usable starting point: it has route/screen entry, meaningful actions, assertions, and clear TODOs only where repo data is missing.
- Recommendation evidence is explainable: output shows the changed file, manifest flow/check, and manifest path to repair when wrong.
- README demo shows the full loop: manifest-free PR QA draft, optional repo context baseline, PR mapping, E2E draft, and remaining validation gaps.
- One manifest correction should improve future PR recommendations without another LLM prompt.

## Now

- Keep the scanner fast, static, and easy to understand.
- Keep the [release validation checklist](release-validation.md), [manifest guide](manifest.md), and public [E2E output examples](e2e-output-examples.md) aligned with the current release bar.
- Keep the [release runbook](releasing.md) ready for npm publishing and versioned GitHub Action follow-up.
- Improve adoption docs and sample output so new maintainers understand the QA manifest plus PR-to-E2E draft loop quickly.
- Stabilize the manifest feedback loop with `.qamap/manifest.yaml`, `manifest init`, `manifest validate`, `manifest explain`, JSON Schema, and manifest-driven E2E draft shaping.
- Keep `manifest context` useful as a pre-init sanity check for repo-local QA memory, harness docs, agent instructions, and runbooks.
- Improve generated drafts until the golden demo feels like a real starting point, not a generic checklist.
- Make `qa` the best first-run experience for AI-assisted PRs; keep `verify`, `e2e`, and `manifest` as the deeper layers behind it.
- Keep `eval` explainable enough that maintainers trust the score and know what to fix.
- Keep expanding representative validation targets beyond JavaScript so planning advice works for Python, Go, Rust, and JVM repositories.

## Next

- Publish a versioned GitHub Action release tag after the first public package is ready.
- Improve `doctor` output with clearer scoring and remediation grouping.
- Improve `review` output for changed-line locations.
- Expand manifest support with richer anchors, symbol-level matching, and configurable taste rubrics.
- Match changed files to flows through a reverse import graph, not only declared anchor paths, so shared component and hook changes map to the flows that depend on them.
- Map changed symbols to manifest anchors after the path/route baseline is stable.
- Keep the `--format agent` output a stable, versioned contract that skills and MCP wrappers can rely on.
- Add language-specific domain patterns for backend services, CLIs, libraries, mobile apps, and infrastructure repositories.
- Continue expanding agent surface detection across popular coding-agent tools without making the public workflow depend on a single vendor.
- Generate rule documentation from scanner metadata.

## Later

- Policy packs for open source, startup teams, and security-sensitive repositories.
- A memory or lessons workflow that captures repeated review feedback into durable agent instructions.
- VS Code and Cursor extension surfaces.
- Maintainer dashboard for repeated AI-assisted PR risks.

## Non-Goals

- QAMap will not execute untrusted project code.
- QAMap will not replace tests, review, branch protection, threat modeling, or security review.
- QAMap will not become a general-purpose code style linter.
- QAMap will not become a deep MCP server analysis engine.
