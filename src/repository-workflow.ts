import { createHash } from "node:crypto";
import type {
  BehaviorLifecycleStage,
  ChangeIntent,
  ChangeIntentEvidence,
  IntentQaScenario,
} from "./change-intent.js";
import { classifyChangeSourceRole, isRepositoryWorkflowPath } from "./source-role.js";
import type { AddedDiffEvidence, AddedDiffHunk, TestPlanChangedFile } from "./test-plan.js";

export interface RepositoryWorkflowAnalysisOptions {
  changedFiles: TestPlanChangedFile[];
  addedDiffEvidence: AddedDiffEvidence;
}

export interface RepositoryWorkflowAnalysis {
  intent?: ChangeIntent;
  diagnostics: string[];
}

export function analyzeRepositoryWorkflowChange(
  options: RepositoryWorkflowAnalysisOptions,
): RepositoryWorkflowAnalysis {
  const changedFiles = options.changedFiles.map((file) => file.path);
  if (changedFiles.length === 0) {
    return { diagnostics: [] };
  }

  const classifications = changedFiles.map((file) => ({
    file,
    role: classifyChangeSourceRole(file, diffText(options.addedDiffEvidence[file] ?? [])).role,
  }));
  const hasRepositoryWorkflow = classifications.some(({ file }) => isRepositoryWorkflowPath(file));
  const hasDocumentation = classifications.some(({ file, role }) =>
    role === "documentation" && !isReleaseMetadataPath(file)
  );
  if (!hasRepositoryWorkflow && !hasDocumentation) {
    return { diagnostics: [] };
  }

  const allowed = classifications.every(({ file, role }) =>
    role === "repository-workflow" ||
    role === "documentation" ||
    role === "test" ||
    role === "generated" ||
    isReleaseMetadataPath(file) ||
    (isPackageMetadataPath(file) && isDocumentationPackagingDiff(options.addedDiffEvidence[file] ?? []))
  );
  if (!allowed) {
    return { diagnostics: [] };
  }

  const orderedClassifications = [...classifications].sort((left, right) =>
    repositoryEvidencePriority(left.file) - repositoryEvidencePriority(right.file) ||
    left.file.localeCompare(right.file)
  );
  const orderedFiles = orderedClassifications.map(({ file }) => file);
  const evidence = orderedClassifications.map(({ file, role }) =>
    buildRepositoryEvidence(file, role, options.addedDiffEvidence[file] ?? [])
  );
  const id = stableId("repository-verification", ...orderedFiles);
  const title = hasRepositoryWorkflow
    ? hasDocumentation
      ? "Repository documentation and contribution workflow"
      : "Repository contribution workflow"
    : "Repository documentation";
  const scenario = buildRepositoryScenario({
    id,
    title,
    files: orderedFiles,
    evidence,
    hasDocumentation,
    hasRepositoryWorkflow,
  });
  const lifecycle = buildRepositoryLifecycle(id, orderedFiles, evidence, hasRepositoryWorkflow);
  const intent: ChangeIntent = {
    id,
    title,
    summary: hasRepositoryWorkflow
      ? "Contributor-facing repository contracts changed without executable product behavior changes."
      : "Repository documentation and its validation or packaging contract changed without executable product behavior changes.",
    confidence: "high",
    commits: [],
    files: orderedFiles,
    keywords: [
      "repository-verification",
      ...(hasDocumentation ? ["documentation"] : []),
      ...(hasRepositoryWorkflow ? ["contribution-workflow"] : []),
    ],
    evidence,
    lifecycle,
    scenarios: [scenario],
    reviewRequired: false,
  };

  return {
    intent,
    diagnostics: [
      `Routed ${orderedFiles.length} documentation or repository workflow file${orderedFiles.length === 1 ? "" : "s"} to repository contract verification.`,
    ],
  };
}

interface RepositoryScenarioOptions {
  id: string;
  title: string;
  files: string[];
  evidence: ChangeIntentEvidence[];
  hasDocumentation: boolean;
  hasRepositoryWorkflow: boolean;
}

function buildRepositoryScenario(options: RepositoryScenarioOptions): IntentQaScenario {
  const issueForms = options.files.filter(isIssueFormPath);
  const pullRequestTemplates = options.files.filter(isPullRequestTemplatePath);
  const packageFiles = options.files.filter(isPackageMetadataPath);
  const contractTests = options.files.filter((file) =>
    classifyChangeSourceRole(file).role === "test"
  );
  const localizedDocs = options.files.filter(isLocalizedDocumentationPath);
  const steps = [
    ...(options.hasDocumentation
      ? ["Resolve every changed local documentation link and verify its target exists in the repository."]
      : []),
    ...(localizedDocs.length > 0
      ? ["Compare localized guides with the primary guide so commands, paths, and installation steps remain equivalent."]
      : []),
    ...(packageFiles.length > 0
      ? ["Run the package dry-run or file-list check and verify every newly referenced documentation file is included."]
      : []),
    ...(issueForms.length > 0
      ? ["Parse each changed issue-form YAML and verify required fields, labels, and assignees remain valid repository metadata."]
      : []),
    ...(pullRequestTemplates.length > 0
      ? ["Inspect each changed pull request template and verify the repository-required sections remain present."]
      : []),
    ...(contractTests.length > 0
      ? ["Run the changed repository documentation or contribution-workflow contract test."]
      : []),
  ];
  const assertions = [
    ...(options.hasDocumentation
      ? ["Verify changed links, commands, and file paths resolve against the current repository."]
      : []),
    ...(packageFiles.length > 0
      ? ["Verify packaged documentation matches the public file list."]
      : []),
    ...(options.hasRepositoryWorkflow
      ? ["Verify contribution metadata parses and preserves every required field and review section."]
      : []),
  ];

  return {
    id: stableId(options.id, "repository-contract"),
    kind: "primary",
    priority: "critical",
    title: `${options.title} contract remains valid`,
    rationale:
      "The diff changes repository-facing guidance or contributor workflow metadata, so validation should prove those contracts instead of inventing a product journey.",
    setup: ["Use the repository checkout and its declared documentation or metadata validation commands."],
    steps,
    assertions,
    edgeCases: [
      ...(options.hasDocumentation
        ? ["A relative link resolves locally but points outside the packaged documentation set."]
        : []),
      ...(options.hasRepositoryWorkflow
        ? ["A syntactically valid template drops a required field, label, assignee, or review section."]
        : []),
    ],
    evidence: options.evidence,
    confidence: "high",
    reviewRequired: false,
  };
}

function buildRepositoryLifecycle(
  id: string,
  files: string[],
  evidence: ChangeIntentEvidence[],
  hasRepositoryWorkflow: boolean,
): BehaviorLifecycleStage[] {
  const directEvidence = evidence.filter((item) => item.relation === "direct");
  return [
    {
      id: stableId(id, "trigger"),
      kind: "trigger",
      label: hasRepositoryWorkflow
        ? "A contributor opens the repository issue or pull request workflow"
        : "A maintainer or user follows the changed repository documentation",
      confidence: "high",
      evidence: directEvidence,
      files,
    },
    {
      id: stableId(id, "action"),
      kind: "action",
      label: hasRepositoryWorkflow
        ? "Follow the changed fields, labels, assignees, and review sections"
        : "Follow the changed links, commands, and packaged guide paths",
      confidence: "high",
      evidence: directEvidence,
      files,
    },
    {
      id: stableId(id, "outcome"),
      kind: "observable-outcome",
      label: "Repository documentation and contribution contracts validate without product-runtime assumptions",
      confidence: "high",
      evidence,
      files,
    },
  ];
}

function buildRepositoryEvidence(
  file: string,
  role: ReturnType<typeof classifyChangeSourceRole>["role"],
  hunks: AddedDiffHunk[],
): ChangeIntentEvidence {
  const added = hunks.flatMap((hunk) => hunk.lines.map((line) => ({ hunk, line, side: "head" as const })))[0];
  const removed = hunks.flatMap((hunk) =>
    (hunk.removedLines ?? []).map((line) => ({ hunk, line, side: "base" as const }))
  )[0];
  const located = added ?? removed;
  const sourceRole = isRepositoryWorkflowPath(file)
    ? "repository-workflow"
    : isDocumentationAssetPath(file)
      ? "generated"
      : role;
  return {
    kind: located ? "diff" : "source",
    value: evidenceDescription(file, sourceRole),
    sourceRole,
    file,
    relation: evidenceRelation(file, sourceRole),
    side: located?.side ?? "head",
    startLine: located?.line.line,
    endLine: located?.line.line,
    hunkHeader: located?.hunk.hunkHeader,
  };
}

function evidenceDescription(
  file: string,
  role: ReturnType<typeof classifyChangeSourceRole>["role"],
): string {
  if (role === "repository-workflow") {
    return `Changed contributor-facing repository workflow metadata in ${file}.`;
  }
  if (isPackageMetadataPath(file)) {
    return `Changed documentation packaging entries in ${file}.`;
  }
  if (role === "test") {
    return `Changed repository contract evidence in ${file}.`;
  }
  if (role === "generated") {
    return `Changed a documentation asset in ${file}.`;
  }
  if (isReleaseMetadataPath(file)) {
    return `Updated release notes accompanying the repository contract in ${file}.`;
  }
  return `Changed repository documentation in ${file}.`;
}

function evidenceRelation(
  file: string,
  role: ReturnType<typeof classifyChangeSourceRole>["role"],
): ChangeIntentEvidence["relation"] {
  if (isReleaseMetadataPath(file)) {
    return "supporting";
  }
  return role === "documentation" || role === "repository-workflow" || isPackageMetadataPath(file)
    ? "direct"
    : "supporting";
}

function repositoryEvidencePriority(file: string): number {
  if (isRepositoryWorkflowPath(file)) return 0;
  if (/^(?:README)(?:\.[^/]+)?$/i.test(file)) return 1;
  if (isLocalizedDocumentationPath(file)) return 2;
  if (classifyChangeSourceRole(file).role === "documentation" && !isReleaseMetadataPath(file)) return 3;
  if (isPackageMetadataPath(file)) return 4;
  if (classifyChangeSourceRole(file).role === "test") return 5;
  if (isReleaseMetadataPath(file)) return 6;
  return 7;
}

function isDocumentationAssetPath(file: string): boolean {
  return /(?:^|\/)docs?\/.+\.(?:avif|bmp|gif|ico|jpe?g|png|webp|svg|pdf|zip)$/i.test(file);
}

function isDocumentationPackagingDiff(hunks: AddedDiffHunk[]): boolean {
  const changedLines = hunks.flatMap((hunk) => [
    ...hunk.lines.map((line) => line.text),
    ...(hunk.removedLines ?? []).map((line) => line.text),
  ]).map((line) => line.trim()).filter(Boolean);
  if (changedLines.length === 0) {
    return false;
  }
  const tokens = changedLines.flatMap((line) =>
    [...line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) => match[1] ?? "")
  );
  return tokens.length > 0 && tokens.every((token) =>
    token === "files" || isDocumentationPackageEntry(token)
  );
}

function isDocumentationPackageEntry(value: string): boolean {
  return /^(?:README(?:\.[^/]+)?|CHANGELOG|LICENSE|NOTICE|docs?|guides?|examples?)(?:[/.].*)?$/i.test(value);
}

function isIssueFormPath(file: string): boolean {
  return /(?:^|\/)\.github\/ISSUE_TEMPLATE\/.+\.ya?ml$/i.test(file);
}

function isPullRequestTemplatePath(file: string): boolean {
  return /(?:^|\/)\.github\/(?:PULL_REQUEST_TEMPLATE(?:\/.*)?\.md|pull_request_template\.md)$/i.test(file);
}

function isLocalizedDocumentationPath(file: string): boolean {
  return /(?:^|\/)README\.[a-z]{2}(?:-[A-Z]{2})?\.md$/i.test(file) ||
    /(?:^|\/)docs?\/[a-z]{2}(?:-[A-Z]{2})?(?:\/|$)/i.test(file);
}

function isReleaseMetadataPath(file: string): boolean {
  return /(?:^|\/)(?:CHANGELOG|RELEASES?|release-notes?|\.release-please-manifest)\.(?:md|json)$/i.test(file) ||
    /(?:^|\/)\.changeset\//i.test(file) ||
    /(?:release-please|changeset)/i.test(file);
}

function isPackageMetadataPath(file: string): boolean {
  return /(?:^|\/)package\.json$/i.test(file);
}

function diffText(hunks: AddedDiffHunk[]): string {
  return hunks.flatMap((hunk) => [
    ...hunk.lines.map((line) => line.text),
    ...(hunk.removedLines ?? []).map((line) => line.text),
  ]).join("\n");
}

function stableId(...values: string[]): string {
  return createHash("sha1").update(values.join("\0")).digest("hex").slice(0, 12);
}
