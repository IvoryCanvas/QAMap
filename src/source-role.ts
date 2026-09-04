import path from "node:path";

export type ChangeSourceRole =
  | "product"
  | "command"
  | "analysis-rule"
  | "repository-workflow"
  | "configuration"
  | "test"
  | "documentation"
  | "generated";

export interface ChangeSourceRoleClassification {
  role: ChangeSourceRole;
  reason: string;
}

export type ChangedSourceRoleMap = Record<string, ChangeSourceRoleClassification>;

export function classifyChangedSourceRoles(
  changedTextByFile: Record<string, string>,
): ChangedSourceRoleMap {
  const classifications = Object.fromEntries(
    Object.entries(changedTextByFile).map(([file, text]) => [
      toPosixPath(file),
      classifyChangeSourceRole(file, text),
    ]),
  );
  const analysisFiles = new Set(
    Object.entries(classifications)
      .filter(([, classification]) => classification.role === "analysis-rule")
      .map(([file]) => file),
  );
  if (analysisFiles.size === 0) {
    return classifications;
  }

  let promoted = true;
  while (promoted) {
    promoted = false;
    for (const [file, text] of Object.entries(changedTextByFile)) {
      const normalizedFile = toPosixPath(file);
      if (classifications[normalizedFile]?.role !== "product") {
        continue;
      }
      if (!referencesChangedAnalysisSource(normalizedFile, text, analysisFiles)) {
        continue;
      }
      classifications[normalizedFile] = {
        role: "analysis-rule",
        reason: "The changed source imports or re-exports another changed static-analysis source.",
      };
      analysisFiles.add(normalizedFile);
      promoted = true;
    }
  }

  for (const [file, text] of Object.entries(changedTextByFile)) {
    const normalizedFile = toPosixPath(file);
    if (
      classifications[normalizedFile]?.role !== "product" ||
      isLikelyProductSurfacePath(normalizedFile) ||
      !hasAnalyzerHelperContract(text)
    ) {
      continue;
    }
    const importingAnalysisFile = [...analysisFiles].find((analysisFile) =>
      referencesChangedSource(analysisFile, changedTextByFile[analysisFile] ?? "", normalizedFile)
    );
    if (!importingAnalysisFile) {
      continue;
    }
    classifications[normalizedFile] = {
      role: "analysis-rule",
      reason: `The changed analyzer source ${importingAnalysisFile} imports this changed analyzer contract helper.`,
    };
    analysisFiles.add(normalizedFile);
  }

  const analysisIdentifiers = new Set(
    [...analysisFiles].flatMap((file) => contractIdentifiers(changedTextByFile[file] ?? "")),
  );
  for (const [file, text] of Object.entries(changedTextByFile)) {
    const normalizedFile = toPosixPath(file);
    if (
      classifications[normalizedFile]?.role !== "product" ||
      !isAnalyzerContractDataPath(normalizedFile)
    ) {
      continue;
    }
    const sharedIdentifiers = schemaContractIdentifiers(text).filter((identifier) =>
      analysisIdentifiers.has(identifier)
    );
    if (sharedIdentifiers.length === 0) {
      continue;
    }
    classifications[normalizedFile] = {
      role: "analysis-rule",
      reason: `The changed contract shares analyzer result fields: ${sharedIdentifiers.slice(0, 3).join(", ")}.`,
    };
  }
  return classifications;
}

export function isTransformationSourcePath(fileInput: string): boolean {
  const file = toPosixPath(fileInput);
  return (
    /(?:^|\/)(?:transformers?|parsers?|serializers?|deserializers?|formatters?|mappers?|converters?|normalizers?|encoders?|decoders?|codecs?)(?:\/|$)/i.test(
      file,
    ) ||
    /(?:^|\/)[^/]*(?:transform|parse|serializ|deserializ|format|convert|normaliz|encode|decode|codec)[^/]*\.[cm]?[jt]sx?$/i.test(
      file,
    )
  );
}

export function classifyChangeSourceRole(
  fileInput: string,
  changedText = "",
): ChangeSourceRoleClassification {
  const file = toPosixPath(fileInput);

  if (isTestPath(file)) {
    return { role: "test", reason: "The path is test, fixture, benchmark, or snapshot evidence." };
  }
  if (isRepositoryWorkflowPath(file)) {
    return {
      role: "repository-workflow",
      reason: "The path defines contributor-facing issue, pull request, or ownership workflow metadata.",
    };
  }
  if (isDocumentationPath(file)) {
    return { role: "documentation", reason: "The path contains documentation rather than executable behavior." };
  }
  if (isGeneratedPath(file)) {
    return { role: "generated", reason: "The path is generated output, a lockfile, or a binary asset." };
  }
  if (isCommandPath(file)) {
    return { role: "command", reason: "The path or changed source defines a command-line entry surface." };
  }
  if (isAnalysisRuleSource(file, changedText)) {
    return {
      role: "analysis-rule",
      reason: "The changed source defines analyzer, matcher, routing, or static-rule behavior.",
    };
  }
  if (hasCommandSourceSignal(changedText)) {
    return { role: "command", reason: "The path or changed source defines a command-line entry surface." };
  }
  if (isConfigurationPath(file)) {
    return { role: "configuration", reason: "The path defines build, runtime, package, or repository configuration." };
  }
  return { role: "product", reason: "The changed source can contribute product or service behavior evidence." };
}

export function isRepositoryWorkflowPath(fileInput: string): boolean {
  const file = toPosixPath(fileInput);
  return /(?:^|\/)\.github\/(?:ISSUE_TEMPLATE\/.+|PULL_REQUEST_TEMPLATE(?:\/.*)?\.md|pull_request_template\.md|CODEOWNERS)$/i.test(
    file,
  );
}

function isTestPath(file: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|fixtures?|snapshots?|benchmarks?|coverage)(?:\/|$)/i.test(file) ||
    /(?:^|\/)[^/]+\.(?:test|spec|stories)\.[^/]+$/i.test(file) ||
    /(?:^|\/)(?:bench|benchmark|jest|vitest|playwright|cypress|karma|mocha|ava|storybook)\.config\.[^/]+$/i.test(file) ||
    /(?:^|\/)scripts\/(?:bench|benchmark)(?:[.-][^/]*)?\.[^/]+$/i.test(file) ||
    /(?:^|\/)__snapshots__(?:\/|$)/i.test(file);
}

function isDocumentationPath(file: string): boolean {
  return /(?:^|\/)(?:docs?|examples?)(?:\/|$)/i.test(file) ||
    /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(?:\.[^/]+)?$/i.test(file) ||
    /\.(?:md|mdx|rst|adoc)$/i.test(file);
}

function isGeneratedPath(file: string): boolean {
  return /(?:^|\/)(?:dist|build|generated|vendor)(?:\/|$)/i.test(file) ||
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(file) ||
    /\.(?:snap|map|min\.js)$/i.test(file) ||
    /\.(?:avif|bmp|gif|ico|jpe?g|png|webp|svg|mp3|m4a|ogg|wav|woff2?|ttf|otf|eot|pdf|zip|gz|br)$/i.test(file);
}

function isCommandPath(file: string): boolean {
  return /(?:^|\/)(?:bin|commands?|cli)(?:\/|$)/i.test(file) ||
    /(?:^|\/)(?:cli|command)(?:\.[^/]+)?$/i.test(file);
}

function hasCommandSourceSignal(text: string): boolean {
  return /\bprocess\.argv\b|\bparseArgs\s*\(|\b(?:commander|yargs|meow|cac)\b|\b(?:program|cli)\.(?:command|requiredOption|option)\s*\(/i.test(text);
}

function isAnalysisRuleSource(file: string, text: string): boolean {
  const pathSignal = /(?:^|\/)(?:analyzers?|classifiers?|heuristics?|linters?|matchers?|policies|rules?|scanner)(?:\/|$)/i.test(file) ||
    /(?:^|\/)(?:change-intent|scenario-routing|qa|qa-trace|rule-engine|analyzer|classifier|heuristic|linter|matcher|scanner)(?:\.[^/]+)?$/i.test(file);
  const sourceRoleClassifier = /(?:^|\/)source-role(?:\.[^/]+)?$/i.test(file) &&
    /\b(?:classify\w*SourceRole|is\w*Path|repository-workflow)\b/i.test(text);
  const staticAnalysisSignal = /\b(?:static[- ]analysis|false positive|negative control|qa scenario|reasoning trace|scenario routing|change intent|diff evidence|source role|routed scenario|analyzer adapter|lint(?:er|ing)?)\b|\b(?:AddedDiffEvidence|ChangeIntentEvidence|QaReasoningTrace|build\w*(?:Trace|Evidence|Scenario)|collectAddedDiffEvidence|routeQaScenario|scenarioAutomation|scenarioEvidence|classifyChangeSourceRole|sourceRole|mustNot\w*|mustFind\w*)\b/i.test(text);
  const vocabularyRuleSignal = /\b(?:analyze\w*Evidence|collect\w*Evidence|\w+Vocabulary|evidencePattern|rulePattern)\b/i.test(text);
  const ruleStructure = /\bRegExp\b|\.match(?:All)?\s*\(|\.test\s*\(|(?:^|\s)\/(?:\\.|[^/\n]){3,}\/\w*|mustNot|mustFind|pattern/i.test(text);
  const analyzerContractStructure = /\b(?:AddedDiffEvidence|ChangeIntentEvidence|QaReasoningTrace|build\w*(?:Trace|Evidence|Scenario)|collectAddedDiffEvidence|route\w*Scenario|scenarioAutomation|classifyChangeSourceRole|intent\.scenarios|trace\.scenario|routingReason)\b/i.test(text);
  const agentActionContractStructure =
    /\b(?:route\.nextAction|execution\.performed|requiredEvidence|evidenceBoundary|executesProjectCode)\b/i.test(text) &&
    /\b(?:agent|qa run|repository (?:code|validation)|execution policy|planning evidence)\b/i.test(text);
  const qaPlanningStructure = /\b(?:TestPlanResult|TestPlanChangedFile|suggestedCommands|discoverSuggestedCommands|discoverRelevant\w*Tests|automationApplicable|verificationStatus)\b/i.test(text);
  const repositoryAnalysisStructure = /\b(?:collectChangedFiles|resolveBaseRef|resolveMergeBase|BaseRefResolution|GitChangedFile|ChangedFilesOptions)\b/i.test(text);
  const repositoryContextPath = /(?:^|\/)(?:git|repo(?:sitory)?)(?:[-_.](?:context|analysis|diff|history|base|change(?:d)?-?files?))?(?:\.[^/]+)?$/i.test(file);
  const analyzerSchema = /(?:^|\/)(?:schemas?|contracts?)(?:\/|$)/i.test(file) &&
    /\b(?:analysis-rule|qamap\.qa|reasoning trace|qa scenario)\b/i.test(text);
  if (analyzerSchema) {
    return true;
  }
  return sourceRoleClassifier ||
    (pathSignal && (staticAnalysisSignal || vocabularyRuleSignal || analyzerContractStructure)) ||
    (staticAnalysisSignal && (ruleStructure || analyzerContractStructure)) ||
    agentActionContractStructure ||
    (repositoryAnalysisStructure && (qaPlanningStructure || repositoryContextPath));
}

function isConfigurationPath(file: string): boolean {
  const basename = path.posix.basename(file);
  return /(?:^|\/)\.github(?:\/|$)/i.test(file) ||
    /(?:^|\/)(?:settings|config)(?:\/|$).+\.py$/i.test(file) ||
    /(?:^|\/)(?:android|ios)(?:\/|$)/i.test(file) && /(?:gradle|plist|pbxproj|xcconfig)$/i.test(basename) ||
    /^(?:AndroidManifest\.xml)$/i.test(basename) ||
    /^(?:package\.json|tsconfig(?:\.[^.]+)?\.json|jsconfig\.json|app\.json|eas\.json|pubspec\.ya?ml|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(basename) ||
    /(?:^|[.-])config\.[^/]+$/i.test(basename) ||
    /^(?:Dockerfile|Makefile|\.env(?:\..+)?)$/i.test(basename);
}

function referencesChangedAnalysisSource(
  file: string,
  text: string,
  analysisFiles: Set<string>,
): boolean {
  return [...analysisFiles].some((analysisFile) => referencesChangedSource(file, text, analysisFile));
}

function referencesChangedSource(file: string, text: string, targetFile: string): boolean {
  const imports = [...text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g,
  )].map((match) => match[1]);
  return imports.some((specifier) => {
    if (!specifier.startsWith(".")) {
      return false;
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    return sameModulePath(resolved, targetFile);
  });
}

function hasAnalyzerHelperContract(text: string): boolean {
  return /\bexport\s+(?:(?:declare|abstract)\s+)?(?:async\s+)?(?:function|class|interface|type|const)\s+[A-Za-z_$][\w$]*(?:Evidence|Authority|Scenario|Trace)\b/i.test(
    text,
  );
}

function isLikelyProductSurfacePath(file: string): boolean {
  return /(?:^|\/)(?:app|components?|controllers?|domain|features?|models?|pages?|routes?|services?|views?)(?:\/|$)/i.test(
    file,
  );
}

function sameModulePath(left: string, right: string): boolean {
  const normalizedLeft = stripModuleExtension(left);
  const normalizedRight = stripModuleExtension(right);
  return normalizedLeft === normalizedRight ||
    `${normalizedLeft}/index` === normalizedRight ||
    normalizedLeft === `${normalizedRight}/index`;
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.(?:[cm]?[jt]sx?|json)$/i, "");
}

function isAnalyzerContractDataPath(file: string): boolean {
  return /(?:^|\/)(?:schemas?|contracts?)(?:\/|$)/i.test(file) &&
    /\.(?:json|json5|ya?ml)$/i.test(file);
}

function contractIdentifiers(text: string): string[] {
  const ignored = new Set([
    "array",
    "boolean",
    "default",
    "description",
    "enum",
    "false",
    "matched",
    "none",
    "null",
    "number",
    "object",
    "properties",
    "required",
    "result",
    "source",
    "status",
    "string",
    "true",
    "type",
  ]);
  return [...new Set(
    [...text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{4,}\b/g)]
      .map((match) => match[0].toLowerCase())
      .filter((identifier) => identifier.length >= 8 && !ignored.has(identifier)),
  )];
}

function schemaContractIdentifiers(text: string): string[] {
  return contractIdentifiers(
    [...text.matchAll(/["']?([A-Za-z_$][A-Za-z0-9_$]{4,})["']?\s*:/g)]
      .map((match) => match[1])
      .join("\n"),
  );
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}
