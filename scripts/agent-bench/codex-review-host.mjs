// Native exec JSONL only; no rollout, auth file or credential copying.
export function codexArguments({ prompt, model, disableSkills = false }) {
  if (!model) throw new Error("Codex measurement requires an explicit --model");
  if (disableSkills) throw new Error("--disable-skills is not supported for Codex; do not claim an equivalent tool restriction");
  return ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config",
    "-c", 'web_search="disabled"', "--model", model, prompt];
}

export function summarizeCodexRun(stdout) {
  const events = [], tools = [], commands = [], answers = [];
  let malformed = false;
  for (const line of stdout.split("\n").filter(line => line.trim())) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) malformed = true;
      else events.push(event);
    } catch { malformed = true; }
  }
  for (const event of events) {
    if (event.type !== "item.completed" || !event.item) continue;
    const item = event.item;
    if (item.type === "agent_message" && typeof item.text === "string") answers.push(item.text);
    if (["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(item.type)) tools.push(item.type);
    if (item.type === "command_execution") commands.push(item.command);
  }
  const receipts = events.filter(event => event.type === "turn.completed");
  const usage = receipts.length === 1 ? receipts[0].usage : null;
  const valid = !malformed && usage && ["input_tokens", "cached_input_tokens", "output_tokens"].every(field =>
    Number.isSafeInteger(usage[field]) && usage[field] >= 0)
    && usage.cached_input_tokens <= usage.input_tokens && Number.isSafeInteger(usage.input_tokens + usage.output_tokens);
  const failed = events.some(event => event.type === "turn.failed" || event.type === "error");
  const policyViolations = [...new Set(tools.filter(tool => ["mcp_tool_call", "web_search", "file_change"].includes(tool)))];
  return {
    completed: !!valid && !failed && !!answers.at(-1)?.trim() && policyViolations.length === 0,
    usage: { input: valid ? usage.input_tokens - usage.cached_input_tokens : null,
      cacheRead: valid ? usage.cached_input_tokens : null, cacheWrite: null, output: valid ? usage.output_tokens : null },
    // Cached input is a subset of input, not an additional token category.
    totalTokens: valid ? usage.input_tokens + usage.output_tokens : null,
    uncachedInputTokens: valid ? usage.input_tokens - usage.cached_input_tokens : null,
    costUsd: null, models: [], requests: null, turns: receipts.length, tools, commands,
    answer: answers.at(-1) ?? "", policyViolations,
    receiptScope: "CLI-reported-turn", modelIdentity: "requested-not-provider-reported",
  };
}
