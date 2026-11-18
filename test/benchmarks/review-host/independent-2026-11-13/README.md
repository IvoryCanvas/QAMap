# Selected public regression snapshots

These two cases follow [the registered protocol](PROTOCOL.md). They are seeded
regressions based on real public fixes, not unmodified naturally occurring PRs.
The fixed snapshots form `main`; `head` restores only the prior production file.
The fixed regression tests stay at base. Missing project files and dependencies
remain outside the selected-files scope. Do not claim these snapshots run as
complete projects or that their tests were executed.

| Case | Public fix | Fixed source | Prior production source | License |
| --- | --- | --- | --- | --- |
| click-gettext | [pallets/click#3901](https://github.com/pallets/click/pull/3901) | `5125851aaa19840c82b9811193b2c2d6cf245326` | `6d34602f4b0668a61873af1c547bfd40cb7deffc` | BSD-3-Clause, preserved at `click-gettext/base/LICENSE.txt` |
| p-limit-clear | [sindresorhus/p-limit#109](https://github.com/sindresorhus/p-limit/pull/109) | `f3e7f9ba364a9357bd912d136367d06c46660917` | `df476048d023ff868cd45b35ee47f5fb0ca2b25a` | MIT, preserved at `p-limit-clear/base/license` |

The Click PR #3918 is docs-only; #3902 exceeds the registered file/line limits.
PR #3901 is the first qualifying bug fix in the inspected order. p-limit #109
qualifies first. `sources.json` pins Git blob and SHA-256 hashes; the package
manifest's `.fixture` suffix is removed only during materialization. The frozen
oracle and source attribution are evaluator inputs outside the host's checkout.
