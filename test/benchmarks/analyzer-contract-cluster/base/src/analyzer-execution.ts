import { analyzeSessionEvidence } from "./rules/session-boundary.js";

export function analyzeSource(source: string) {
  return { matched: analyzeSessionEvidence(source) };
}
