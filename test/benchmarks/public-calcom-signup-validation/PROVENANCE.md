# Public PR provenance

This fixture is a behavior-preserving reduction of a public Cal.com pull request.
It keeps the changed validation mode, the observable signup form states, and the
added regression cases while removing unrelated application code so the benchmark
can run deterministically without network access.

- Repository: `calcom/cal.diy`
- Pull request: <https://github.com/calcom/cal.diy/pull/27765>
- Base commit: `e940aac2f1bc1d589ae9a03803edb0abda6837e7`
- Head commit: `614c4d533a9047b031d78a4da65bdfaec472c3a5`
- Merged: 2026-02-09
- License: MIT
- Behavior under review: defer signup email validation until the field first
  loses focus, then keep revalidation responsive as the user corrects the value.

Expected QA judgment, derived from the public PR description and test plan:

1. Initial typing must not show an invalid-email error.
2. Leaving an incomplete email must show the error.
3. Correcting the value after the first blur must clear the error.
4. Form submission must still validate all fields.

The benchmark does not claim to execute Cal.com. It checks whether QAMap preserves
this reasoning path and recognizes the added test file as existing evidence.
