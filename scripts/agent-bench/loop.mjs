// The agent loop shared by both benchmark arms. It is deliberately minimal:
// one system prompt, one task prompt, then tool calls until the provider stops
// or the turn budget is spent. Token counts are summed only from provider
// usage fields; a field the provider did not report stays null.

export const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

export async function runAgentLoop({ provider, tools, executor, system, prompt, maxTurns, now = Date.now }) {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error("maxTurns must be a positive integer.");
  }
  const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let toolCalls = 0;
  let turns = 0;
  let stopReason = "max-turns";
  const startedAt = now();

  while (turns < maxTurns) {
    turns += 1;
    let response;
    try {
      response = await provider.complete({ system, messages, tools });
    } catch (cause) {
      const error = new Error(cause instanceof Error ? cause.message : String(cause));
      error.receipt = { ...Object.fromEntries(USAGE_FIELDS.map((field) => [field, null])),
        partialUsage: { ...usage }, usageComplete: false, toolCalls, turns,
        stopReason: "provider-error", wallClockMs: now() - startedAt };
      throw error;
    }
    addUsage(usage, response.usage);
    messages.push(response.assistantMessage);
    if (response.toolUses.length === 0) {
      stopReason = response.stopReason;
      break;
    }
    // Tool-call count is the number of tool_use blocks the provider returned,
    // including calls that fail inside the tool layer.
    toolCalls += response.toolUses.length;
    const results = [];
    for (const toolUse of response.toolUses) {
      let content;
      let isError = false;
      try {
        content = await executor.execute(toolUse.name, toolUse.input);
      } catch (error) {
        content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      results.push({ type: "tool_result", toolUseId: toolUse.id, content, isError });
    }
    messages.push({ role: "user", content: results });
  }

  return { ...usage, toolCalls, turns, stopReason, wallClockMs: now() - startedAt };
}

function addUsage(total, usage) {
  for (const field of USAGE_FIELDS) {
    if (total[field] === null) continue;
    const value = usage?.[field];
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total[field] + value)) {
      total[field] = null;
      continue;
    }
    total[field] += value;
  }
}
