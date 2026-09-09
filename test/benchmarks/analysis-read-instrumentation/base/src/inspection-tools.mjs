// Tools can return a QA scenario for review.
export function analyzeEvidence(source) {
  return /request/.test(source);
}

export function readChunk(buffer, bytesRead, recorder) {
  recorder.read(bytesRead);
  return buffer.subarray(0, bytesRead);
}
