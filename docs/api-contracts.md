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

## QA Routing And Mock Generation Are Separate

Repository evidence can still tell QAMap that a changed screen calls an endpoint,
that a visible failure state exists, and that the behavior needs success or
failure QA. Those facts are enough to route a QA scenario. They are not enough
to invent a response body.

QAMap reports four authority states for a matching endpoint:

| State | What the repository proves | What QAMap can do |
| --- | --- | --- |
| `example` | The contract contains an explicit JSON response example. | Copy that exact example into an optional local response scaffold. |
| `schema` | The contract contains a usable JSON response schema, but no exact example. | Preserve method, status, media type, compact shape, and `schema-derived` provenance. Keep fixture readiness `partial` until a schema-aware adapter or repository fixture materializes values. |
| `contract-only` | The operation exists, but only status metadata, non-JSON content, or an unresolved schema is available. | Route QA, name the evidence gap, and refuse payload generation. |
| `missing` | No matching operation exists. | Route QA from the diff only and request an authoritative contract or fixture. |

QAMap generates a local JSON response only when all of these facts join:

- a matching OpenAPI or Swagger operation exists;
- one HTTP method is unambiguous for the detected endpoint;
- the relevant status has a concrete JSON response example;
- the example is bounded and does not contain credential-shaped fields.

The generated body is copied from that exact example and marked
`explicit-example`. QAMap does not derive values from endpoint names, UI copy,
TypeScript response types, schema property names, or nearby fixture keys.

An operation with a usable JSON response schema is stronger than status-only
metadata. QAMap keeps each documented response scenario and records a compact
shape from an inline schema or a valid local `$ref`. It does not turn that shape
into plausible-looking values. The plan instead asks for a schema-aware
materializer or a repository-owned fixture and keeps those future values labeled
`schema-derived`.

Existing MSW, Mirage, Playwright, seed, and fixture files may guide the
maintainer to the right integration point. Their filenames and object keys alone
do not become a new network contract. A separate adapter may derive handlers
from the authoritative specification, but QAMap itself remains runner-neutral.

If the pull request changes the endpoint implementation itself, QAMap observes
the real response instead of intercepting it with a synthetic success response.
This prevents an optional draft from hiding the contract under review.

The response-evidence path currently reads OpenAPI and Swagger JSON or YAML.
Schema provenance currently requires JSON content and supports inline schemas or
resolvable local references. Other accepted contract sources still contribute
to the broader `QM013` source-of-truth check, but they do not currently authorize
generated JSON handlers.

## References

- [Why frontend developers design APIs](https://blog.gangnamunni.com/post/saas-why-do-frontend-developers-design-api)
- [Single source of truth](https://ko.wikipedia.org/wiki/%EB%8B%A8%EC%9D%BC_%EC%A7%84%EC%8B%A4_%EA%B3%B5%EA%B8%89%EC%9B%90)
