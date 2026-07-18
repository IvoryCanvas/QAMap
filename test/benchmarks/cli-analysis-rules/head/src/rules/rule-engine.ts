const schedulingVocabulary = /scheduledAt|reminder|calendar|timezone/i;
const validationVocabulary = /guard|validation|permission/i;
const networkVocabulary = /\/api\/orders|fixture|mock/i;

export function analyzeEvidence(source: string) {
  return {
    request: /request|response/.test(source),
    vocabularyOnly:
      schedulingVocabulary.test(source) ||
      validationVocabulary.test(source) ||
      networkVocabulary.test(source),
  };
}
