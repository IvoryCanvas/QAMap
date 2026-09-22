import { createHash } from "node:crypto";

export function gradeReportEvidence(handoff, files, criteria, bytes) {
  const integrityErrors = [];
  const returned = new Map();
  const excerpts = new Map();
  const checkedFiles = new Map();
  for (const [index, pair] of (handoff.reviewEvidence?.paths ?? []).entries()) {
    const fields = [["source", pair.source], ["contract", pair.contract],
      ...(pair.via ?? []).map((excerpt, i) => [`via/${i}`, excerpt])];
    for (const [field, supplied] of fields) {
      let excerpt = supplied;
      if (!excerpt) { integrityErrors.push("missing-excerpt"); continue; }
      if (excerpt.excerptRef !== undefined) {
        const original = excerpts.get(excerpt.excerptRef);
        if (!original || original.file !== excerpt.file || original.line !== excerpt.line
          || original.changedLine !== excerpt.changedLine
          || JSON.stringify(original.changedLines) !== JSON.stringify(excerpt.changedLines)
          || JSON.stringify(original.deletionLines) !== JSON.stringify(excerpt.deletionLines)
          || JSON.stringify(original.contextLines) !== JSON.stringify(excerpt.contextLines)
          || JSON.stringify(original.anchorLines) !== JSON.stringify(excerpt.anchorLines)) {
          integrityErrors.push(`invalid-excerpt-reference:${excerpt.excerptRef}`); continue;
        }
        excerpt = original;
      } else excerpts.set(`/reviewEvidence/paths/${index}/${field}`, excerpt);
      const source = files[excerpt.file];
      if (typeof source !== "string") { integrityErrors.push(`unknown-file:${excerpt.file}`); continue; }
      const hash = createHash("sha256").update(source).digest("hex");
      if (excerpt.lines) checkedFiles.set(excerpt.file, hash);
      if (hash !== excerpt.sourceHash && !(excerpt.sourceHash === undefined && handoff.reviewEvidence?.sourceDigest)) {
        integrityErrors.push(`hash-mismatch:${excerpt.file}`); continue;
      }
      for (const item of excerpt.lines ?? []) {
        if (!Number.isSafeInteger(item.line) || item.line < 1 || source.split("\n")[item.line - 1] !== item.text) {
          integrityErrors.push(`incorrect-line:${excerpt.file}:${item.line}`);
          continue;
        }
        returned.set(`${excerpt.file}:${item.line}`, item.text);
      }
    }
  }
  if (handoff.reviewEvidence?.sourceDigest) {
    const digest = handoff.reviewEvidence.sourceDigest;
    const entries = [...checkedFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const expected = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    if (digest.algorithm !== "sha256" || digest.fileCount !== entries.length || !entries.length || digest.value !== expected) {
      integrityErrors.push("source-digest-mismatch");
    }
  }
  const obligations = criteria.anchors.map(anchor => ({ ...anchor,
    present: returned.get(`${anchor.file}:${anchor.line}`) === anchor.text }));
  const requiredGapPresent = !criteria.requiredGap || (handoff.reviewEvidence?.gaps ?? []).some(gap =>
    gap.file === criteria.requiredGap.file && gap.reason === criteria.requiredGap.reason);
  const safety = {
    schema: handoff.schema?.name === "qamap.qa.handoff" && handoff.schema.version === 1,
    analysisComplete: handoff.analysis === "complete",
    staticNotRun: handoff.execution?.status === "not-run" && handoff.execution.performed === false
      && handoff.summary?.execution?.status === "not-run" && handoff.summary.execution.performed === false,
    localAnalysis: handoff.usage?.analysisLlmCalls === 0 && handoff.usage.callerTokens === "not-measured",
    incompleteCoverageDisclosed: handoff.reviewEvidence?.complete === false,
    bounded: Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 16384,
    accurateExcerpts: integrityErrors.length === 0,
  };
  const passed = Object.values(safety).every(Boolean) && requiredGapPresent && obligations.every(item => item.present);
  return { status: passed ? "evidence-ready" : "evidence-insufficient", passed, safety,
    requiredGapPresent, integrityErrors, obligations,
    required: obligations.length, retained: obligations.filter(item => item.present).length,
    missing: obligations.filter(item => !item.present).map(item => item.id),
    modelQuality: "not-measured", semanticFalsePositives: "not-measured", tokenSavings: "not-measured" };
}
