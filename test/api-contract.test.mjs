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
        "              schema:",
        "                type: object",
        "                properties:",
        "                  id: { type: string }",
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
    provenance: "explicit-example",
    body: { id: "item-1", key: "display-name", state: "ready" },
  });
  const authority = summarizeApiContractAuthority(operations, ["/api/items/item-1"]);
  assert.equal(authority.status, "example");
  assert.equal(authority.schemas?.[0].provenance, "schema-derived");
});

test("schema-only operations preserve response scenarios without claiming exact payloads", () => {
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
  assert.equal(authority.status, "schema");
  assert.deepEqual(authority.sources, ["openapi.json"]);
  assert.deepEqual(authority.examples, []);
  assert.deepEqual(authority.schemas, [
    {
      file: "openapi.json",
      endpoint: "/api/items",
      method: "POST",
      status: 201,
      mediaType: "application/json",
      provenance: "schema-derived",
      shape: {
        type: "object",
        properties: ["id"],
        required: [],
      },
    },
  ]);
});

test("local schema references retain compact provenance for success and error scenarios", () => {
  const operations = collectApiContractOperations([
    {
      path: "contracts/openapi.yaml",
      text: [
        "openapi: 3.1.0",
        "components:",
        "  schemas:",
        "    Report:",
        "      type: object",
        "      required: [id, state]",
        "      properties:",
        "        id: { type: string }",
        "        state: { type: string }",
        "    Problem:",
        "      type: object",
        "      required: [code]",
        "      properties:",
        "        code: { type: string }",
        "paths:",
        "  /api/reports/{id}:",
        "    get:",
        "      responses:",
        "        '200':",
        "          content:",
        "            application/json:",
        "              schema:",
        "                $ref: '#/components/schemas/Report'",
        "        '404':",
        "          content:",
        "            application/problem+json:",
        "              schema:",
        "                $ref: '#/components/schemas/Problem'",
      ].join("\n"),
    },
  ]);

  const authority = summarizeApiContractAuthority(operations, ["/api/reports/report-1"]);
  assert.equal(authority.status, "schema");
  assert.deepEqual(
    authority.schemas.map((schema) => [schema.status, schema.mediaType, schema.shape]),
    [
      [200, "application/json", {
        type: "object",
        properties: ["id", "state"],
        required: ["id", "state"],
        reference: "#/components/schemas/Report",
      }],
      [404, "application/problem+json", {
        type: "object",
        properties: ["code"],
        required: ["code"],
        reference: "#/components/schemas/Problem",
      }],
    ],
  );
});

test("OpenAPI 3.1 nullable primitive types remain schema-backed evidence", () => {
  const operations = collectApiContractOperations([
    {
      path: "openapi.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/api/lookup": {
            get: {
              responses: {
                200: {
                  content: {
                    "application/json": { schema: { type: ["string", "null"] } },
                  },
                },
              },
            },
          },
        },
      }),
    },
  ]);

  const authority = summarizeApiContractAuthority(operations, ["/api/lookup"]);
  assert.equal(authority.status, "schema");
  assert.deepEqual(authority.schemas?.[0].shape.type, ["string", "null"]);
});

test("status-only, non-JSON, and unresolved schemas remain contract-only", () => {
  const operations = collectApiContractOperations([
    {
      path: "openapi.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/api/status-only": {
            get: { responses: { 204: { description: "No content" } } },
          },
          "/api/text": {
            get: {
              responses: {
                200: {
                  content: {
                    "text/plain": { schema: { type: "string" } },
                  },
                },
              },
            },
          },
          "/api/unresolved": {
            get: {
              responses: {
                200: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Missing" } },
                  },
                },
              },
            },
          },
        },
      }),
    },
  ]);

  for (const endpoint of ["/api/status-only", "/api/text", "/api/unresolved"]) {
    const authority = summarizeApiContractAuthority(operations, [endpoint]);
    assert.equal(authority.status, "contract-only");
    assert.deepEqual(authority.examples, []);
    assert.deepEqual(authority.schemas, []);
  }
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
  assert.match(authority.reason, /no safe, unambiguous JSON response example or schema/i);
  assert.deepEqual(authority.examples, []);
  assert.deepEqual(authority.schemas, []);
});
