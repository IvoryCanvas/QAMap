export function analyzeEvidence(source: string): boolean {
  return /request/.test(source);
}
