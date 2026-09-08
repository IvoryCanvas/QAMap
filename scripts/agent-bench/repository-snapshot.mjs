// Runs in the fixture's isolated environment so the CLI later uses the SAME
// default cache namespace and canonical root. No head analysis is prebuilt.
import { pathToFileURL } from "node:url";

const { buildRepositoryEvidenceIndex } = await import(pathToFileURL(process.argv[2]).href);
const index = await buildRepositoryEvidenceIndex(process.argv[3]);
process.stdout.write(JSON.stringify({ fingerprint: index.coverage.fingerprint,
  indexedFiles: index.coverage.indexedFiles, reuse: index.reuse }));
