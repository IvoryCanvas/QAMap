// A bounded exact oracle for public benchmark answers, not a semantic QA judge.
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function snapshotEvidenceFixture(root) {
  const hash = createHash("sha256");
  let count = 0;
  async function visit(relative) {
    const entries = (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!relative && [".git", ".qamap", "qa-result.json", "qa-notes.md"].includes(entry.name)) continue;
      const file = path.posix.join(relative, entry.name);
      if (++count > 500) throw new Error("Evidence fixture exceeds its file limit.");
      const stat = await fs.lstat(path.join(root, file));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.size > 1_048_576) {
        throw new Error("Evidence fixture contains an unsupported entry.");
      }
      hash.update(JSON.stringify([file, stat.isDirectory(), stat.mode & 0o777]));
      if (stat.isDirectory()) await visit(file);
      else hash.update(await fs.readFile(path.join(root, file)));
    }
  }
  await visit("");
  return hash.digest("hex");
}

export function evaluateEvidenceAnswer(answer, expected) {
  const invalid = { passed: false, evidencePrecision: 0, evidenceRecall: 0,
    contractCompleteness: 0, uncertaintyCorrect: false, executionCorrect: false };
  if (!validAnswer(answer) || !validAnswer(expected)) return invalid;
  const key = ({ file, line }) => JSON.stringify([file, line]);
  const required = new Set(expected.evidence.map(key));
  const submitted = new Set(answer.evidence.map(key));
  const matched = [...submitted].filter((entry) => required.has(entry)).length;
  const contracts = Object.keys(expected.contracts);
  const contractMatches = contracts.filter((name) => Object.hasOwn(answer.contracts, name)
    && isDeepStrictEqual(answer.contracts[name], expected.contracts[name])).length;
  const result = {
    evidencePrecision: submitted.size ? matched / submitted.size : 0,
    evidenceRecall: required.size ? matched / required.size : 0,
    contractCompleteness: contracts.length ? contractMatches / contracts.length : 0,
    uncertaintyCorrect: isDeepStrictEqual([...answer.uncertainties].sort(), [...expected.uncertainties].sort()),
    executionCorrect: answer.execution === expected.execution,
  };
  return { ...result, passed: result.evidencePrecision === 1 && result.evidenceRecall === 1
    && result.contractCompleteness === 1 && result.uncertaintyCorrect && result.executionCorrect
    && submitted.size === answer.evidence.length && Object.keys(answer.contracts).length === contracts.length };
}

function validAnswer(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 4
    && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.length <= 64
    && value.evidence.every((item) => item && Object.keys(item).length === 2
      && typeof item.file === "string" && /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(item.file)
      && Number.isSafeInteger(item.line) && item.line > 0)
    && value.contracts && typeof value.contracts === "object" && !Array.isArray(value.contracts)
    && Object.keys(value.contracts).length > 0 && Object.keys(value.contracts).length <= 64
    && Array.isArray(value.uncertainties) && value.uncertainties.length <= 64
    && value.uncertainties.every((item) => typeof item === "string")
    && ["not-run", "passed", "failed", "blocked"].includes(value.execution);
}
