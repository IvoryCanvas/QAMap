import assert from "node:assert/strict";
import test from "node:test";
import {
  createProvider,
  parseAnthropicUsage,
  parseOpenAiUsage,
  SUPPORTED_PROVIDERS,
} from "../scripts/agent-bench/provider.mjs";

const secret = "test-provider-credential-0123456789";
const tools = [{
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}];

test("usage parsers return provider-reported counts exactly and never estimate", () => {
  assert.deepEqual(
    parseAnthropicUsage({
      usage: { input_tokens: 1200, output_tokens: 345, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
    }),
    { inputTokens: 1200, outputTokens: 345, cacheReadTokens: 1000, cacheWriteTokens: 50 },
  );
  assert.deepEqual(
    parseAnthropicUsage({ usage: { input_tokens: 10, output_tokens: 0 } }),
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null },
  );
  assert.deepEqual(
    parseOpenAiUsage({
      usage: { prompt_tokens: 900, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 256 } },
    }),
    { inputTokens: 900, outputTokens: 120, cacheReadTokens: 256, cacheWriteTokens: null },
  );
  assert.deepEqual(
    parseOpenAiUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    { inputTokens: 7, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null },
  );

  assert.throws(() => parseAnthropicUsage({}), /no usage object/);
  assert.throws(() => parseAnthropicUsage({ usage: { output_tokens: 1 } }), /input_tokens is missing/);
  assert.throws(() => parseAnthropicUsage({ usage: { input_tokens: "12", output_tokens: 1 } }), /input_tokens is missing/);
  assert.throws(() => parseAnthropicUsage({ usage: { input_tokens: 12 } }), /output_tokens is missing/);
  assert.throws(() => parseOpenAiUsage({ content: "no usage" }), /no usage object/);
  assert.throws(() => parseOpenAiUsage({ usage: { prompt_tokens: 5 } }), /completion_tokens is missing/);
  assert.throws(() => parseOpenAiUsage({ usage: { prompt_tokens: -1, completion_tokens: 5 } }), /prompt_tokens is missing/);
});

test("anthropic provider sends the key only in the header and maps tool use", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({
      content: [
        { type: "text", text: "Reading the manifest." },
        { type: "tool_use", id: "call-1", name: "read_file", input: { path: "package.json" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 321, output_tokens: 45, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
    });
  };
  const provider = createProvider({ name: "anthropic", model: "pinned-model", apiKey: secret, fetchImpl });

  const first = await provider.complete({
    system: "Be brief.",
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect the repository." }] }],
    tools,
  });

  assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["x-api-key"], secret);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, "pinned-model");
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.system, "Be brief.");
  assert.deepEqual(body.tools[0].input_schema, tools[0].inputSchema);
  assert.deepEqual(first.toolUses, [{ id: "call-1", name: "read_file", input: { path: "package.json" } }]);
  assert.equal(first.stopReason, "tool-use");
  assert.deepEqual(first.usage, { inputTokens: 321, outputTokens: 45, cacheReadTokens: 300, cacheWriteTokens: 0 });
  assert.doesNotMatch(JSON.stringify(first), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(provider), new RegExp(secret));
  assert.equal(Object.values(provider).includes(secret), false);

  await provider.complete({
    system: "Be brief.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the repository." }] },
      first.assistantMessage,
      { role: "user", content: [{ type: "tool_result", toolUseId: "call-1", content: "{}", isError: false }] },
    ],
    tools,
  });
  const secondBody = JSON.parse(requests[1].init.body);
  assert.deepEqual(secondBody.messages[1].content[1], {
    type: "tool_use",
    id: "call-1",
    name: "read_file",
    input: { path: "package.json" },
  });
  assert.deepEqual(secondBody.messages[2].content[0], { type: "tool_result", tool_use_id: "call-1", content: "{}" });
});

test("openai provider sends a bearer header and maps tool calls and tool results", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-9", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
        },
      }],
      usage: { prompt_tokens: 210, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 128 } },
    });
  };
  const provider = createProvider({ name: "openai", model: "pinned-model", apiKey: secret, fetchImpl, maxOutputTokens: 512 });

  const first = await provider.complete({
    system: "Be brief.",
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect the repository." }] }],
    tools,
  });

  assert.equal(requests[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${secret}`);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.max_completion_tokens, 512);
  assert.deepEqual(body.messages[0], { role: "system", content: "Be brief." });
  assert.deepEqual(body.tools[0].function.parameters, tools[0].inputSchema);
  assert.deepEqual(first.toolUses, [{ id: "call-9", name: "read_file", input: { path: "README.md" } }]);
  assert.equal(first.stopReason, "tool-use");
  assert.deepEqual(first.usage, { inputTokens: 210, outputTokens: 12, cacheReadTokens: 128, cacheWriteTokens: null });
  assert.doesNotMatch(JSON.stringify(first), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(provider), new RegExp(secret));

  await provider.complete({
    system: "Be brief.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the repository." }] },
      first.assistantMessage,
      { role: "user", content: [{ type: "tool_result", toolUseId: "call-9", content: "# Title", isError: false }] },
    ],
    tools,
  });
  const secondBody = JSON.parse(requests[1].init.body);
  assert.equal(secondBody.messages[2].role, "assistant");
  assert.equal(secondBody.messages[2].tool_calls[0].function.arguments, "{\"path\":\"README.md\"}");
  assert.deepEqual(secondBody.messages[3], { role: "tool", tool_call_id: "call-9", content: "# Title" });
});

test("provider errors and construction never expose the key", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => `authentication failed for ${secret}`,
  });
  const provider = createProvider({ name: "anthropic", model: "pinned-model", apiKey: secret, fetchImpl });
  await assert.rejects(
    provider.complete({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }),
    (error) => /status 401/.test(error.message) && !error.message.includes(secret),
  );

  const missingUsage = createProvider({
    name: "openai",
    model: "pinned-model",
    apiKey: secret,
    fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] }),
  });
  await assert.rejects(
    missingUsage.complete({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }),
    /never estimated/,
  );

  assert.deepEqual(SUPPORTED_PROVIDERS, ["anthropic", "openai"]);
  assert.throws(() => createProvider({ name: "other", model: "m", apiKey: secret, fetchImpl }), /Unsupported provider/);
  assert.throws(() => createProvider({ name: "anthropic", model: "m", apiKey: "", fetchImpl }), /key is required/);
  assert.throws(() => createProvider({ name: "anthropic", model: "", apiKey: secret, fetchImpl }), /model is required/);
});

function jsonResponse(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) };
}
