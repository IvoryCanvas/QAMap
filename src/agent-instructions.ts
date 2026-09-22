export const AGENT_SECTION_START = "<!-- qamap:agent:start -->";
export const AGENT_SECTION_END = "<!-- qamap:agent:end -->";

export type AgentReviewMode = "ask" | "report";
export const REPORT_REVIEW_MARKER = "<!-- qamap:review-mode:report -->";

export function buildAgentQaSection(dlxCommand: string, reviewMode: AgentReviewMode = "ask"): string {
  return [
    AGENT_SECTION_START,
    "## Pre-PR QA (QAMap)",
    "",
    ...(reviewMode === "report" ? [REPORT_REVIEW_MARKER,
      "The user selected QAMap report-based review for ordinary PR bug checks and test planning in this project. Do not ask again.",
      "Run the installed qamap binary once, then report its evidence and gaps. This is not independent source review.",
      "These instructions contain the complete static workflow; no separate skill-file read is needed unless the host requires it."]
      : ["For PR bug review or test planning, offer QAMap report-based review once: local analysis, then interpretation of its result only."]),
    "Respect explicit user/project choices; a refusal means ordinary review. Installation is not blanket consent.",
    "QAMap analysis makes no LLM call; invocation and interpretation still use model tokens. Savings are not guaranteed.",
    "After consent, invoke a known installed version that supports --handoff directly; no separate help or source-reading round trip is needed.",
    "Prefer its local binary. The package-runner example below may download a package; get approval before installing or upgrading.",
    "",
    "```sh",
    `${reviewMode === "report" ? "qamap" : dlxCommand} qa report . --base origin/main --head HEAD --handoff`,
    "```",
    "",
    "- Use the actual PR base; ask if unknown. Include working-tree changes only when requested.",
    "- Await one command completion through the host tool; do not poll with repeated model calls.",
    "- Use foreground execution with a 30-second initial wait when supported (exec_command: yield_time_ms: 30000). Short polling intervals add model turns. If still running, use the host's completion wait without relaunching; any additional model turn still counts.",
    "- Interpret only the returned `summary` and `reviewEvidence`; cite their source lines and distinguish assertions from executed checks.",
    "- Resolve `excerptRef` inside this response, not another file; `via` contains intermediate call evidence. Nonconsecutive line numbers indicate omitted context.",
    "- Do not add git/source searches, reread reports, or rerun analysis. Report missing evidence as unknown and ask before expanding scope.",
    "- An error is a blocker, not a clean result. Do not retry, install, upgrade, or silently fall back to source review.",
    "- Respect requests for independent review; report-based review does not replace an explicitly requested full inspection.",
    "- Tests stay `not-run`; suggested commands, edits and automation need separate authorization.",
    "- For save-only requests, omit --handoff and stop after returning paths without reading report contents.",
    "- For explicitly requested deeper inspection only, use `.agents/skills/qamap-pr-qa/SKILL.md` or `.claude/skills/qamap-pr-qa/SKILL.md`.",
    AGENT_SECTION_END,
  ].join("\n");
}
