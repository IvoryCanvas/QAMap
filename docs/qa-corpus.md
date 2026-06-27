# OSS Corpus QA

CodeWard includes an opt-in QA corpus for testing the CLI against real public repositories without adding network-dependent work to the default test suite.

Run the corpus:

```sh
pnpm qa:corpus
```

Run a subset:

```sh
pnpm qa:corpus -- --repo express
pnpm qa:corpus -- --ecosystem go
pnpm qa:corpus -- --limit 2
```

The runner:

- shallow clones public repositories into `.codeward-corpus/`
- runs `codeward scan`
- applies a synthetic local source-file change inside the temporary clone
- runs `codeward test-plan --include-working-tree`
- runs `codeward eval --include-working-tree`
- verifies that expected validation command patterns are present
- writes `codeward-corpus-report.json`

The default corpus currently covers JavaScript, Python, Go, Rust, and Maven repositories. It is intentionally not part of `pnpm test` because network access, GitHub availability, and upstream repository changes can make corpus QA slower and less deterministic than unit tests.

Add or adjust repositories in [`qa/oss-corpus.json`](../qa/oss-corpus.json).
