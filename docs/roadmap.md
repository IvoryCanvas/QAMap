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

- Treat the committed [benchmark contract](benchmarking.md) as the quality gate for recommendations, not only implementation correctness. Reduce real failures into public fixtures and require `pnpm bench:ci` on every PR.
- Make `qa` the primary product surface. Its first screen and `--format agent` payload should agree on affected behavior, reviewer question, repository evidence, draft path, and missing trust requirements.
- Improve changed-file impact mapping from shared symbols and components to consuming routes, screens, API contracts, and manifest flows.
- Keep the [release validation checklist](release-validation.md), [manifest guide](manifest.md), public [E2E output examples](e2e-output-examples.md), and README examples aligned with captured output from the public fixtures.
- Stabilize the manifest feedback loop with `.qamap/manifest.yaml`, `manifest init`, `manifest validate`, `manifest explain`, JSON Schema, and manifest-driven E2E draft shaping.
- Keep `manifest context` useful as a pre-init sanity check for repo-local QA memory, harness docs, agent instructions, and runbooks.
- Improve generated drafts until the golden demo feels like a real starting point, not a generic checklist.
- Keep `verify`, `e2e`, and `manifest` as deeper layers behind `qa`; freeze new scanner, doctor, eval, domains, flows, and history features until the core QA contract is consistently useful.

## Next

- Add symbol-level anchors for exported components, hooks, API clients, handlers, schemas, and queries after the public import-impact fixture stays stable.
- Add a manifest correction command that proposes the exact flow/anchor patch and applies it only after human approval, avoiding routine hand-edits to YAML.
- Add stronger deterministic draft adapters for Playwright and Maestro while keeping `manual` output for API, CLI, token, and catalog repositories.
- Expand the public benchmark corpus with package-scoped monorepos, auth/session changes, dynamic routes, API failure fixtures, and non-JavaScript services.
- Keep the `--format agent` output a stable, versioned contract that skills and MCP wrappers can rely on.
- Continue expanding agent surface detection across popular coding-agent tools without making the public workflow depend on a single vendor.

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
