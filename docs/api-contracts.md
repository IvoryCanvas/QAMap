# API Contract Source Of Truth

Frontend and backend teams often coordinate through API documents. That works best when the document is generated from a single contract source, not hand-maintained separately from code and client types.

QAMap looks for a narrow drift signal:

- Markdown or text docs that list HTTP endpoints in a method-plus-path form
- No machine-readable API contract source in the repository

When both are true, QAMap reports `QM013`.

## Accepted Contract Sources

QAMap currently treats these as machine-readable contract sources:

- OpenAPI or Swagger: `openapi.yaml`, `openapi.yml`, `openapi.json`, `swagger.yaml`, `swagger.yml`, `swagger.json`
- AsyncAPI: `asyncapi.yaml`, `asyncapi.yml`, `asyncapi.json`
- Protocol Buffers: `*.proto`, `buf.yaml`, `buf.gen.yaml`
- GraphQL SDL: `*.graphql`, `*.graphqls`, `schema.graphql`, `schema.graphqls`

## Why It Matters

AI coding agents can edit frontend clients, backend handlers, tests, and docs in the same pull request. If the API contract exists only as prose, agents and reviewers have a harder time knowing which representation is authoritative.

Prefer one source of truth that can generate docs, validation, mock servers, or client types. This keeps API design review close to the code and reduces drift between documentation and implementation.

## References

- [Why frontend developers design APIs](https://blog.gangnamunni.com/post/saas-why-do-frontend-developers-design-api)
- [Single source of truth](https://ko.wikipedia.org/wiki/%EB%8B%A8%EC%9D%BC_%EC%A7%84%EC%8B%A4_%EA%B3%B5%EA%B8%89%EC%9B%90)
