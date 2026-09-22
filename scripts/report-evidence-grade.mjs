import { createHash } from "node:crypto";

export function gradeReportEvidence(handoff, files, criteria, bytes) {
  const integrityErrors = [];
  const returned = new Map();
  const excerpts = new Map();
  const checkedFiles = new Map();
  const inlineGaps = [];
  if (handoff.inlineReview) {
    // Deliberately independent of the production decoder: validate every table,
    // reconstruct numbered lines, and compare to the frozen fixture, not itself.
    try {
      const packet = handoff.inlineReview;
      if (packet.encoding !== "lossless-text-tables-v1") throw Error("encoding");
      const records = new Map();
      for (const table of packet.tables) {
        const positions = Array.isArray(table.at) ? table.at
          : Array.from({ length: table.at.count }, (_, i) => table.at.start + i);
        if (positions.length !== table.rows.length) throw Error("rows");
        for (let i = 0; i < positions.length; i++) {
          const position = positions[i];
          if (!Number.isSafeInteger(position) || position < 0 || position >= packet.records || records.has(position)) throw Error("record");
          records.set(position, table.parts.map(part => {
            if (typeof part === "string") return part;
            if (!Number.isSafeInteger(part) || part < 0 || typeof table.rows[i][part] !== "string") throw Error("column");
            return table.rows[i][part];
          }).join(""));
        }
      }
      if (records.size !== packet.records) throw Error("missing-record");
      const text = [...records].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
      if (Buffer.byteLength(text) !== packet.bytes || createHash("sha256").update(text).digest("hex") !== packet.sha256) throw Error("digest");
      const digest = text.match(/^Source identities: sha256=([a-f0-9]{64}); files=(\d+)\./m);
      const identities = new Map();
      let file;
      for (const line of text.split("\n")) {
        const header = line.match(/^FILE (".*")$/);
        if (header) {
          file = JSON.parse(header[1]);
          if (typeof files[file] !== "string") throw Error(`unknown-file:${file}`);
          identities.set(file, createHash("sha256").update(files[file]).digest("hex"));
        }
        const numbered = line.match(/^(\d+)\|(.*)$/);
        if (numbered && file) {
          if (files[file].split(/\r?\n/)[Number(numbered[1]) - 1] !== numbered[2]) throw Error(`incorrect-line:${file}:${numbered[1]}`);
          returned.set(`${file}:${numbered[1]}`, numbered[2]);
        }
        const gap = line.match(/^(\[.*\]) count=/);
        if (gap) { const [file, reason] = JSON.parse(gap[1]); inlineGaps.push({ file, reason }); }
      }
      if (!digest || Number(digest[2]) !== identities.size || digest[1] !== createHash("sha256")
        .update(JSON.stringify([...identities].sort())).digest("hex")) throw Error("source-digest");
    } catch (error) { integrityErrors.push(`inline-review:${error.message}`); }
  }
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
  const requiredGapPresent = !criteria.requiredGap || [...(handoff.reviewEvidence?.gaps ?? []), ...inlineGaps].some(gap =>
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
