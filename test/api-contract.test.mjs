import assert from "node:assert/strict";
import test from "node:test";

import {
  collectApiContractOperations,
  summarizeApiContractAuthority,
} from "../dist/api-contract.js";

test("collectApiContractOperations preserves exact OpenAPI response examples", () => {
  const operations = collectApiContractOperations([
    {
      path: "contracts/openapi.yaml",
      text: [
        "openapi: 3.1.0",
        "paths:",
        "  /api/items/{id}:",
        "    get:",
        "      responses:",
        "        '200':",
        "          content:",
        "            application/json:",
        "              example:",
        "                id: item-1",
        "                key: display-name",
        "                state: ready",
      ].join("\n"),
    },
  ]);

  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].statuses, [200]);
  assert.deepEqual(operations[0].examples[0], {
    file: "contracts/openapi.yaml",
    endpoint: "/api/items/{id}",
    method: "GET",
    status: 200,
    mediaType: "application/json",
    body: { id: "item-1", key: "display-name", state: "ready" },
  });
  assert.equal(summarizeApiContractAuthority(operations, ["/api/items/item-1"]).status, "example");
});

test("schema-only operations remain contract evidence without authorizing a payload", () => {
  const operations = collectApiContractOperations([
    {
      path: "openapi.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/api/items": {
            post: {
              responses: {
                201: {
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { id: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    },
  ]);

  const authority = summarizeApiContractAuthority(operations, ["/api/items"]);
  assert.equal(authority.status, "contract-only");
  assert.deepEqual(authority.sources, ["openapi.json"]);
  assert.deepEqual(authority.examples, []);
});

test("ambiguous methods and unrelated specs cannot authorize response generation", () => {
  const operations = collectApiContractOperations([
    {
      path: "openapi.yaml",
      text: [
        "openapi: 3.1.0",
        "paths:",
        "  /api/items:",
        "    get:",
        "      responses:",
        "        '200':",
        "          content:",
        "            application/json:",
        "              example: { items: [] }",
        "    post:",
        "      responses:",
        "        '201':",
        "          content:",
        "            application/json:",
        "              example: { id: item-1 }",
        "  /api/unrelated:",
        "    get:",
        "      responses:",
        "        '200':",
        "          content:",
        "            application/json:",
        "              example: { ok: true }",
      ].join("\n"),
    },
  ]);

  const ambiguous = summarizeApiContractAuthority(operations, ["/api/items"]);
  assert.equal(ambiguous.status, "contract-only");
  assert.deepEqual(ambiguous.examples, []);

  const missing = summarizeApiContractAuthority(operations, ["/api/missing"]);
  assert.equal(missing.status, "missing");
  assert.deepEqual(missing.sources, []);
});

test("credential-shaped examples never authorize generated payloads", () => {
  const operations = collectApiContractOperations([
    {
      path: "openapi.yaml",
      text: [
        "openapi: 3.1.0",
        "paths:",
        "  /api/session:",
        "    post:",
        "      responses:",
        "        '200':",
        "          content:",
        "            application/json:",
        "              example:",
        "                user: demo-user",
        "                access_token: should-not-be-copied",
      ].join("\n"),
    },
  ]);

  const authority = summarizeApiContractAuthority(operations, ["/api/session"]);
  assert.equal(authority.status, "contract-only");
  assert.match(authority.reason, /no safe, unambiguous response example/i);
  assert.deepEqual(authority.examples, []);
});
