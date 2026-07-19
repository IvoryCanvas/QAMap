import path from "node:path";

export type ChangeSourceRole =
  | "product"
  | "command"
  | "analysis-rule"
  | "configuration"
  | "test"
  | "documentation"
  | "generated";

export interface ChangeSourceRoleClassification {
  role: ChangeSourceRole;
  reason: string;
}

export function classifyChangeSourceRole(
  fileInput: string,
  changedText = "",
): ChangeSourceRoleClassification {
  const file = toPosixPath(fileInput);

  if (isTestPath(file)) {
    return { role: "test", reason: "The path is test, fixture, benchmark, or snapshot evidence." };
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
  const staticAnalysisSignal = /\b(?:static[- ]analysis|false positive|negative control|qa scenario|reasoning trace|scenario routing|change intent|diff evidence|source role|routed scenario|analyzer adapter|lint(?:er|ing)?)\b|\b(?:AddedDiffEvidence|ChangeIntentEvidence|QaReasoningTrace|build\w*(?:Trace|Evidence|Scenario)|collectAddedDiffEvidence|routeQaScenario|scenarioAutomation|scenarioEvidence|classifyChangeSourceRole|sourceRole|mustNot\w*|mustFind\w*)\b/i.test(text);
  const vocabularyRuleSignal = /\b(?:analyzeEvidence|collect\w*Evidence|\w+Vocabulary|evidencePattern|rulePattern)\b/i.test(text);
  const ruleStructure = /\bRegExp\b|\.match(?:All)?\s*\(|\.test\s*\(|(?:^|\s)\/(?:\\.|[^/\n]){3,}\/\w*|mustNot|mustFind|pattern/i.test(text);
  const analyzerContractStructure = /\b(?:AddedDiffEvidence|ChangeIntentEvidence|QaReasoningTrace|build\w*(?:Trace|Evidence|Scenario)|collectAddedDiffEvidence|route\w*Scenario|scenarioAutomation|classifyChangeSourceRole|intent\.scenarios|trace\.scenario|routingReason)\b/i.test(text);
  const analyzerSchema = /(?:^|\/)(?:schemas?|contracts?)(?:\/|$)/i.test(file) &&
    /\b(?:analysis-rule|qamap\.qa|reasoning trace|qa scenario)\b/i.test(text);
  if (analyzerSchema) {
    return true;
  }
  return (pathSignal && (staticAnalysisSignal || vocabularyRuleSignal || analyzerContractStructure)) ||
    (staticAnalysisSignal && (ruleStructure || analyzerContractStructure));
}

function isConfigurationPath(file: string): boolean {
  const basename = path.posix.basename(file);
  return /(?:^|\/)\.github(?:\/|$)/i.test(file) ||
    /(?:^|\/)(?:settings|config)(?:\/|$).+\.py$/i.test(file) ||
    /(?:^|\/)(?:android|ios)(?:\/|$)/i.test(file) && /(?:gradle|plist|pbxproj|xcconfig)$/i.test(basename) ||
    /^(?:package\.json|tsconfig(?:\.[^.]+)?\.json|jsconfig\.json|app\.json|eas\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(basename) ||
    /(?:^|[.-])config\.[^/]+$/i.test(basename) ||
    /^(?:Dockerfile|Makefile|\.env(?:\..+)?)$/i.test(basename);
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}
