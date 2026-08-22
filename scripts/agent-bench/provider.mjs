// Provider adapters for the agent token benchmark. Every adapter reads token
// usage from the provider's own usage fields and throws when they are absent,
// so the benchmark never estimates a token count. The key is only ever placed
// in the request header; it is not stored on the returned provider object and
// is redacted from error messages.

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export const SUPPORTED_PROVIDERS = ["anthropic", "openai"];
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function parseAnthropicUsage(json) {
  const usage = requireUsage(json, "anthropic");
  return {
    inputTokens: requireCount(usage, "input_tokens", "anthropic"),
    outputTokens: requireCount(usage, "output_tokens", "anthropic"),
    cacheReadTokens: optionalCount(usage, "cache_read_input_tokens"),
    cacheWriteTokens: optionalCount(usage, "cache_creation_input_tokens"),
  };
}

export function parseOpenAiUsage(json) {
  const usage = requireUsage(json, "openai");
  return {
    inputTokens: requireCount(usage, "prompt_tokens", "openai"),
    outputTokens: requireCount(usage, "completion_tokens", "openai"),
    cacheReadTokens: optionalCount(usage.prompt_tokens_details, "cached_tokens"),
    // The chat completions usage object has no cache-write field. Null keeps
    // "not reported" distinct from a measured zero.
    cacheWriteTokens: null,
  };
}

export function createProvider({
  name,
  model,
  apiKey,
  fetchImpl = globalThis.fetch,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  endpoint,
}) {
  if (!SUPPORTED_PROVIDERS.includes(name)) {
    throw new Error(`Unsupported provider "${name}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}.`);
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("A provider model is required.");
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("A provider key is required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("maxOutputTokens must be a positive integer.");
  }
  const adapter = name === "anthropic" ? anthropicAdapter : openAiAdapter;
  const url = endpoint ?? adapter.url;

  return {
    name,
    model,
    maxOutputTokens,
    async complete({ system, messages, tools }) {
      const body = adapter.buildRequest({ model, system, messages, tools, maxOutputTokens });
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...adapter.headers(apiKey) },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `${name} request failed with status ${response.status}: ${redact(text, apiKey).slice(0, 300)}`,
        );
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${name} response was not valid JSON.`);
      }
      return adapter.parseResponse(json);
    },
  };
}

const anthropicAdapter = {
  url: ANTHROPIC_MESSAGES_URL,
  headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
  buildRequest({ model, system, messages, tools, maxOutputTokens }) {
    return {
      model,
      max_tokens: maxOutputTokens,
      system,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content.map(toAnthropicBlock),
      })),
    };
  },
  parseResponse(json) {
    const content = Array.isArray(json.content) ? json.content : [];
    const blocks = content
      .map((block) => {
        if (block?.type === "tool_use") {
          return { type: "tool_use", id: String(block.id), name: String(block.name), input: block.input ?? {} };
        }
        if (block?.type === "text") {
          return { type: "text", text: String(block.text ?? "") };
        }
        return null;
      })
      .filter(Boolean);
    return {
      assistantMessage: { role: "assistant", content: blocks },
      toolUses: toolUsesOf(blocks),
      usage: parseAnthropicUsage(json),
      stopReason: normalizeStopReason(json.stop_reason),
    };
  },
};

const openAiAdapter = {
  url: OPENAI_CHAT_COMPLETIONS_URL,
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildRequest({ model, system, messages, tools, maxOutputTokens }) {
    return {
      model,
      max_completion_tokens: maxOutputTokens,
      messages: [{ role: "system", content: system }, ...messages.flatMap(toOpenAiMessages)],
      tools: tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
    };
  },
  parseResponse(json) {
    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (!choice || typeof choice.message !== "object" || choice.message === null) {
      throw new Error("openai response has no choices[0].message.");
    }
    const message = choice.message;
    const blocks = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      blocks.push({
        type: "tool_use",
        id: String(call.id),
        name: String(call.function?.name ?? ""),
        input: parseToolArguments(call.function?.arguments),
      });
    }
    return {
      assistantMessage: { role: "assistant", content: blocks },
      toolUses: toolUsesOf(blocks),
      usage: parseOpenAiUsage(json),
      stopReason: normalizeStopReason(choice.finish_reason),
    };
  },
};

function toAnthropicBlock(block) {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    default:
      throw new Error(`Unsupported message block type "${block.type}".`);
  }
}

function toOpenAiMessages(message) {
  if (message.role === "assistant") {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const toolCalls = message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));
    return [{
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }];
  }
  const converted = [];
  for (const block of message.content) {
    if (block.type === "text") {
      converted.push({ role: "user", content: block.text });
    } else if (block.type === "tool_result") {
      converted.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
    } else {
      throw new Error(`Unsupported message block type "${block.type}".`);
    }
  }
  return converted;
}

function toolUsesOf(blocks) {
  return blocks
    .filter((block) => block.type === "tool_use")
    .map(({ id, name, input }) => ({ id, name, input }));
}

function parseToolArguments(value) {
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Malformed arguments reach the tool as an empty input so the tool's own
    // validation message goes back to the model instead of aborting the run.
    return {};
  }
}

function normalizeStopReason(value) {
  switch (value) {
    case "tool_use":
    case "tool_calls":
      return "tool-use";
    case "end_turn":
    case "stop":
      return "end-turn";
    case "max_tokens":
    case "length":
      return "max-tokens";
    default:
      return value ? String(value) : "unknown";
  }
}

function requireUsage(json, provider) {
  const usage = json && typeof json === "object" ? json.usage : undefined;
  if (!usage || typeof usage !== "object") {
    throw new Error(`${provider} response has no usage object; token counts are never estimated.`);
  }
  return usage;
}

function requireCount(usage, field, provider) {
  const value = usage[field];
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${provider} usage.${field} is missing; token counts are never estimated.`);
  }
  return value;
}

function optionalCount(record, field) {
  const value = record && typeof record === "object" ? record[field] : undefined;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function redact(text, secret) {
  return secret ? String(text).split(secret).join("[redacted]") : String(text);
}
