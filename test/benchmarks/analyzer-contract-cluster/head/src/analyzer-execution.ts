import { analyzeSessionEvidence } from "./rules/session-boundary.js";

export function analyzeSource(source: string) {
  const matched = analyzeSessionEvidence(source);
  return { matched, evidenceKind: matched ? "session-boundary" : "none" };
}
