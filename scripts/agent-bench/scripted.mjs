// A scripted stand-in provider for `--dry-run`. It never talks to a network,
// returns a fixed tool-call sequence so the tool layer is exercised end to end,
// and reports null usage so a dry run can never be mistaken for a measurement.

const NULL_USAGE = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };

const GENERIC_SCRIPT = [
  [
    { name: "list_dir", input: {} },
    { name: "bash", input: { command: "git log --oneline main..HEAD" } },
  ],
  [
    { name: "bash", input: { command: "git diff --stat main...HEAD" } },
    { name: "grep", input: { pattern: "export", path: "src" } },
    { name: "read_file", input: { path: "missing-file.txt" } },
  ],
  [
    { name: "read_file", input: { path: "package.json" } },
    { name: "bash", input: { command: "printf 'dry run\\n' > qa-notes.md" } },
  ],
];

const QAMAP_SCRIPT = [
  GENERIC_SCRIPT[0],
  [
    ...GENERIC_SCRIPT[1],
    { name: "qamap_qa", input: { format: "agent" } },
  ],
  [
    { name: "qamap_e2e_draft_dry_run", input: {} },
    { name: "qamap_qa_run", input: {} },
  ],
  GENERIC_SCRIPT[2],
];

export function createScriptedProvider({ arm }) {
  const script = arm === "qamap" ? QAMAP_SCRIPT : GENERIC_SCRIPT;
  return {
    name: "scripted",
    model: null,
    async complete({ messages }) {
      const turn = messages.filter((message) => message.role === "assistant").length;
      const step = script[turn];
      if (!step) {
        return {
          assistantMessage: { role: "assistant", content: [{ type: "text", text: "Dry run complete." }] },
          toolUses: [],
          usage: NULL_USAGE,
          stopReason: "end-turn",
        };
      }
      const toolUses = step.map((call, index) => ({
        type: "tool_use",
        id: `scripted-${turn + 1}-${index + 1}`,
        name: call.name,
        input: call.input,
      }));
      return {
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: `Dry run turn ${turn + 1}.` }, ...toolUses],
        },
        toolUses: toolUses.map(({ id, name, input }) => ({ id, name, input })),
        usage: NULL_USAGE,
        stopReason: "tool-use",
      };
    },
  };
}
