// Tools can return a QA scenario for review.
export function analyzeEvidence(source) {
  return /request/.test(source);
}

export function readChunk(buffer, bytesRead, recorder) {
  recorder.read(bytesRead);
  recorder.directRead(buffer.subarray(0, bytesRead));
  return buffer.subarray(0, bytesRead);
}
