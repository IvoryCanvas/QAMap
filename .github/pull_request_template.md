## Why

<!-- What real failure, missed risk, false positive, or user problem does this change address? -->

## Behavioral Contract

<!-- What should QAMap infer, route, cite, generate, or execute after this change? -->

## Evidence

<!-- Name the minimized fixture, positive/negative controls, or public reproduction. -->

- [ ] Focused regression test added or updated.
- [ ] `pnpm test`
- [ ] `pnpm bench:ci` for QA inference, routing, trace, or output changes.
- [ ] `pnpm bench:execution` for E2E compiler or execution-fixture changes.
- [ ] `pnpm scan` for scanner, security, or repository-policy changes.

## Public OSS Check

- [ ] No private repository name, path, source, customer data, credential, or internal smoke output is included.
- [ ] Shared inference is proven across unrelated positive cases and a negative control, or this PR explains why that contract is not applicable.
- [ ] User-facing commands and claims match actual behavior.

## Review Notes

<!-- Compatibility, safety, rollout, remaining limits, or "None". Maintainers handle assignment and labels. -->
