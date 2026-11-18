# Pilot status, 2026-11-13

**No eligible paired token or quality comparison was completed.**

The candidate was frozen at `97bcb42ad12ae19b862b4561bbea6bda5834ffc2` before
loading these cases. Both selected snapshots passed source-hash checks and
materialized successfully in an offline dry run. They contain seeded public
regressions with retained tests; no project dependencies were installed and no
repository tests were run by a review arm.

| Host | Case | QAMap arm | Standalone arm |
| --- | --- | --- | --- |
| Codex CLI 0.167.0-alpha.4, requested `gpt-6.1-sol` | click-gettext | Ineligible: CLI initialization failed before a completion receipt | Not run: fail-fast |
| Same | p-limit-clear | Not run: fail-fast | Not run: fail-fast |
| Claude Code | Both | Not run: CLI unavailable in the workspace | Not run |

Codex could report an existing ChatGPT login, but its in-process app-server
could not initialize writable state in the supplied environment (read-only
filesystem). A setup wrapper initially pointed at a nonexistent Node path;
that pre-model setup error was corrected before the host launch. Neither
failure supports a token estimate, and missing usage remains unknown, not zero.

No model answer, defect grade, savings percentage, billing or comparative runtime
claim is available. Retain the failed attempt as a setup diagnostic. Do not
retry or downgrade isolation merely to obtain a favorable result. Re-run the
registered experiment in a suitable authenticated, writable host environment
with the same frozen candidate or clearly register a new candidate. Raw private
runner diagnostics are not included in this public record.
