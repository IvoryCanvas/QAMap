export function analyzeSessionEvidence(source: string): boolean {
  return /session/.test(source);
}
