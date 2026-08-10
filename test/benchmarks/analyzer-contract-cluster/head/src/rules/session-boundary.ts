const boundaryPattern = /session\.(?:start|resume)/;
const vocabularyOnlyPattern = /session boundary/i;

export function analyzeSessionEvidence(source: string): boolean {
  return boundaryPattern.test(source) && !vocabularyOnlyPattern.test(source);
}
