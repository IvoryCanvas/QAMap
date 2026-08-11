import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readFileAtRef } from "./git-context.js";
import { expandFilesWithImports } from "./import-graph.js";
import type {
  ChangeIntent,
  ChangeIntentEvidence,
  IntentQaScenario,
} from "./change-intent.js";
import type {
  AddedDiffEvidence,
  AddedDiffHunk,
  TestPlanChangedFile,
} from "./test-plan.js";

export interface RuntimePrerequisiteAnalysisOptions {
  root: string;
  workspaceRoot?: string;
  head: string;
  includeWorkingTree: boolean;
  changedFiles: TestPlanChangedFile[];
  addedDiffEvidence: AddedDiffEvidence;
}

export interface RuntimePrerequisiteFinding {
  route: string;
  consumer: string;
  contract: string;
  wrapper: string;
  provider: string;
  marker: string;
  chain: string[];
  intent: ChangeIntent;
}

export interface RuntimePrerequisiteAnalysis {
  findings: RuntimePrerequisiteFinding[];
  diagnostics: string[];
}

interface FailFastContextContract {
  file: string;
  provider: string;
  hook?: string;
  line: number;
  message: string;
}

interface WrapperBypass {
  file: string;
  marker: string;
  markerLine: number;
  bypassLine: number;
}

const maxDependencyHops = 4;
const maxChangedRoutes = 12;
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

export async function analyzeRuntimePrerequisites(
  options: RuntimePrerequisiteAnalysisOptions,
): Promise<RuntimePrerequisiteAnalysis> {
  const root = path.resolve(options.root);
  const routeFiles = options.changedFiles
    .filter((file) => !file.status.startsWith("D") && isRoutableSurfaceFile(file.path))
    .map((file) => file.path)
    .slice(0, maxChangedRoutes);
  if (routeFiles.length === 0) {
    return { findings: [], diagnostics: [] };
  }

  const findings: RuntimePrerequisiteFinding[] = [];
  const diagnostics: string[] = [];
  const sourceCache = new Map<string, Promise<string | undefined>>();
  const readCachedSource = (file: string): Promise<string | undefined> => {
    const cached = sourceCache.get(file);
    if (cached) {
      return cached;
    }
    const pending = readSource(options, file);
    sourceCache.set(file, pending);
    return pending;
  };
  for (const route of routeFiles) {
    let expansion;
    try {
      expansion = await expandFilesWithImports(root, [route], maxDependencyHops);
    } catch {
      diagnostics.push(`Skipped runtime prerequisite analysis for ${route} because its local import graph was unavailable.`);
      continue;
    }
    const sources = new Map<string, string>();
    for (const file of expansion.files) {
      const content = await readCachedSource(file);
      if (content) {
        sources.set(file, content);
      }
    }
    const routeContent = sources.get(route);
    if (!routeContent) {
      continue;
    }

    const markers = routeBranchMarkers(routeContent);
    if (markers.length === 0) {
      continue;
    }
    const contracts = [...sources.entries()]
      .filter(([file]) => file !== route)
      .map(([file, content]) => parseFailFastContextContract(file, content))
      .filter((contract): contract is FailFastContextContract => Boolean(contract));

    for (const contract of contracts) {
      const chain = expansion.via[contract.file];
      if (!chain || chain.length < 2 || routeWrapsProvider(routeContent, contract.provider)) {
        continue;
      }
      const wrapper = await findWrapperBypass(route, markers, contract.provider, readCachedSource);
      if (!wrapper) {
        continue;
      }
      const consumer = chain.at(-2) ?? route;
      const directEvidence = routeDiffEvidence(
        route,
        chain,
        wrapper.marker,
        options.addedDiffEvidence[route] ?? [],
      );
      if (!directEvidence) {
        diagnostics.push(
          `Skipped ${route} runtime prerequisite because the reused consumer or wrapper marker was not located in the diff.`,
        );
        continue;
      }
      const consumerContent = sources.get(consumer) ?? await readCachedSource(consumer);
      const evidence = [
        directEvidence,
        sourceEvidence(
          consumer,
          consumerContent,
          contract.hook,
          `The import chain ${chain.join(" -> ")} reaches the fail-fast context consumer.`,
        ),
        {
          kind: "source" as const,
          value: `${contract.message} The context contract explicitly requires ${contract.provider}.`,
          sourceRole: "product" as const,
          file: contract.file,
          symbol: contract.hook,
          relation: "supporting" as const,
          side: "head" as const,
          startLine: contract.line,
          endLine: contract.line,
        },
        {
          kind: "source" as const,
          value:
            `${wrapper.marker} selects a wrapper branch that renders the page directly while ` +
            `${contract.provider} is applied on a different branch.`,
          sourceRole: "product" as const,
          file: wrapper.file,
          symbol: wrapper.marker,
          relation: "supporting" as const,
          side: "head" as const,
          startLine: wrapper.markerLine,
          endLine: wrapper.bypassLine,
        },
      ];
      findings.push({
        route,
        consumer,
        contract: contract.file,
        wrapper: wrapper.file,
        provider: contract.provider,
        marker: wrapper.marker,
        chain,
        intent: buildRuntimePrerequisiteIntent({
          route,
          consumer,
          contract,
          wrapper,
          chain,
          evidence,
        }),
      });
      break;
    }
  }

  return { findings, diagnostics };
}

function buildRuntimePrerequisiteIntent(input: {
  route: string;
  consumer: string;
  contract: FailFastContextContract;
  wrapper: WrapperBypass;
  chain: string[];
  evidence: ChangeIntentEvidence[];
}): ChangeIntent {
  const routeName = titleCase(routeSubject(input.route));
  const providerName = splitIdentifier(input.contract.provider);
  const id = stableId("runtime-prerequisite", input.route, input.contract.provider, input.wrapper.marker);
  const scenario: IntentQaScenario = {
    id: stableId(id, "provider-render"),
    kind: "failure",
    priority: "critical",
    title: `${routeName} renders with required ${providerName} context`,
    rationale:
      `${input.route} reuses ${input.consumer}, whose import chain reaches an explicit ` +
      `${input.contract.provider} invariant. The ${input.wrapper.marker} wrapper branch renders the page outside that provider.`,
    setup: [
      `Render ${input.route} through the production app wrapper in ${input.wrapper.file}.`,
      `Keep ${input.consumer} and ${input.contract.hook ?? "the context consumer"} real; do not mock away the provider contract.`,
    ],
    steps: [
      `Open ${routeName} through the ${input.wrapper.marker} wrapper path.`,
      `Render the reused consumer chain: ${input.chain.join(" -> ")}.`,
      "Observe the first render before interacting with the page.",
    ],
    assertions: [
      `Verify ${routeName} reaches its first visible state without a missing-${input.contract.provider} runtime error.`,
      `Verify ${input.consumer} receives the required context through the production wrapper path.`,
    ],
    edgeCases: [
      "A component-mocked unit test can pass while the production wrapper still omits the required context.",
      "Public, embedded, authentication-free, or custom-layout branches may bypass providers used by internal routes.",
    ],
    evidence: input.evidence,
    confidence: "high",
    reviewRequired: false,
  };

  return {
    id,
    title: `${routeName} runtime provider prerequisite`,
    summary:
      `The changed route reaches a fail-fast ${input.contract.provider} consumer through local imports, ` +
      `but its ${input.wrapper.marker} wrapper branch renders outside that provider.`,
    confidence: "high",
    commits: [],
    files: uniqueStrings([...input.chain, input.wrapper.file]),
    keywords: ["runtime-prerequisite", "provider", input.contract.provider, input.wrapper.marker],
    evidence: input.evidence,
    lifecycle: [
      {
        id: stableId(id, "trigger"),
        kind: "trigger",
        label: `Open ${routeName} through the ${input.wrapper.marker} wrapper path`,
        confidence: "high",
        evidence: [input.evidence[0]],
        files: [input.route],
      },
      {
        id: stableId(id, "condition"),
        kind: "condition",
        label: `${input.consumer} requires ${input.contract.provider} through ${input.contract.hook ?? "a context hook"}`,
        confidence: "high",
        evidence: input.evidence.slice(1, 3),
        files: [input.consumer, input.contract.file],
      },
      {
        id: stableId(id, "action"),
        kind: "action",
        label: `${input.wrapper.file} renders the marked page on a provider-bypass branch`,
        confidence: "high",
        evidence: [input.evidence[3]],
        files: [input.wrapper.file],
      },
      {
        id: stableId(id, "outcome"),
        kind: "observable-outcome",
        label: `${routeName} reaches its first visible state with the required provider context`,
        confidence: "high",
        evidence: input.evidence,
        files: [input.route, input.consumer, input.contract.file, input.wrapper.file],
      },
    ],
    scenarios: [scenario],
    reviewRequired: false,
  };
}

function parseFailFastContextContract(file: string, content: string): FailFastContextContract | undefined {
  if (!/\buseContext\s*\(/.test(content)) {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/\bthrow\s+new\s+Error\s*\(/.test(line)) {
      continue;
    }
    const throwText = lines.slice(index, index + 5).join("\n");
    const provider = throwText.match(/\b([A-Z][A-Za-z0-9_$]*Provider)\b/)?.[1];
    if (!provider) {
      continue;
    }
    const nearbyStart = Math.max(0, index - 30);
    const nearby = lines.slice(nearbyStart, index + 1).join("\n");
    if (!/\buseContext\s*\(/.test(nearby)) {
      continue;
    }
    const hook = [...nearby.matchAll(/\b(?:function\s+|const\s+)(use[A-Z][A-Za-z0-9_$]*)\b/g)].at(-1)?.[1];
    const message = throwText.match(/Error\s*\(\s*["'`]([^"'`]+)["'`]/)?.[1] ?? line.trim();
    return { file, provider, hook, line: index + 1, message };
  }
  return undefined;
}

async function findWrapperBypass(
  route: string,
  markers: string[],
  provider: string,
  readSourceFile: (file: string) => Promise<string | undefined>,
): Promise<WrapperBypass | undefined> {
  for (const file of runtimeWrapperCandidates(route)) {
    const content = await readSourceFile(file);
    if (!content || !new RegExp(`<\\s*${escapeRegExp(provider)}\\b`).test(content)) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const marker of markers) {
      const markerIndex = lines.findIndex((line) => new RegExp(`\\.\\s*${escapeRegExp(marker)}\\b`).test(line));
      if (markerIndex === -1) {
        continue;
      }
      const markerBranch = lines.slice(markerIndex, markerIndex + 12);
      const bypassOffset = markerBranch.findIndex((line, offset) =>
        /\breturn\b/.test(line) &&
        /<\s*Component\b/.test(markerBranch.slice(offset, offset + 6).join("\n"))
      );
      if (bypassOffset === -1) {
        continue;
      }
      const returnExpression = boundedReturnExpression(markerBranch, bypassOffset);
      if (new RegExp(`<\\s*${escapeRegExp(provider)}\\b`).test(returnExpression)) {
        continue;
      }
      const providerIndex = lines.findIndex((line) => new RegExp(`<\\s*${escapeRegExp(provider)}\\b`).test(line));
      if (providerIndex === -1) {
        continue;
      }
      return {
        file,
        marker,
        markerLine: markerIndex + 1,
        bypassLine: markerIndex + bypassOffset + 1,
      };
    }
  }
  return undefined;
}

function boundedReturnExpression(lines: string[], start: number): string {
  const expression: string[] = [];
  for (const line of lines.slice(start, start + 6)) {
    expression.push(line);
    if (line.includes(";")) {
      break;
    }
  }
  return expression.join("\n");
}

function routeBranchMarkers(content: string): string[] {
  const ignored = new Set(["displayName", "propTypes", "defaultProps"]);
  return uniqueStrings(
    [...content.matchAll(/\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?![=>])/g)]
      .map((match) => match[1])
      .filter((marker): marker is string => Boolean(marker) && !ignored.has(marker)),
  );
}

function routeWrapsProvider(content: string, provider: string): boolean {
  return new RegExp(`<\\s*${escapeRegExp(provider)}\\b`).test(content);
}

function runtimeWrapperCandidates(route: string): string[] {
  const normalized = toPosix(route);
  const candidates: string[] = [];
  const pagesMatch = /^(.*?)(?:pages)\/.+\.[^.]+$/.exec(normalized);
  if (pagesMatch) {
    const prefix = pagesMatch[1] ?? "";
    candidates.push(...sourceExtensions.map((extension) => `${prefix}pages/_app${extension}`));
  }
  const appMatch = /^(.*?app)(?:\/(.+))?\/page\.[^.]+$/.exec(normalized);
  if (appMatch) {
    const appRoot = appMatch[1];
    const routeDirectory = path.posix.dirname(normalized);
    let directory = routeDirectory;
    while (directory === appRoot || directory.startsWith(`${appRoot}/`)) {
      candidates.push(...sourceExtensions.map((extension) => `${directory}/layout${extension}`));
      if (directory === appRoot) {
        break;
      }
      directory = path.posix.dirname(directory);
    }
  }
  for (const rootFile of ["src/App", "src/main", "App", "main"]) {
    candidates.push(...sourceExtensions.map((extension) => `${rootFile}${extension}`));
  }
  return uniqueStrings(candidates);
}

function routeDiffEvidence(
  route: string,
  chain: string[],
  marker: string,
  hunks: AddedDiffHunk[],
): ChangeIntentEvidence | undefined {
  const importedFile = chain[1];
  const importedSymbol = importedFile ? path.posix.basename(importedFile).replace(/\.[^.]+$/, "") : undefined;
  const located = hunks.flatMap((hunk) =>
    hunk.lines.map((line) => ({ hunk, line }))
  ).find(({ line }) =>
    (importedSymbol && line.text.includes(importedSymbol)) || line.text.includes(`.${marker}`)
  );
  if (!located) {
    return undefined;
  }
  return {
    kind: "diff",
    value:
      `Changed route ${route} reuses ${importedSymbol ?? importedFile ?? "a local consumer"} ` +
      `and selects the ${marker} wrapper branch.`,
    sourceRole: "product",
    file: route,
    symbol: importedSymbol,
    relation: "direct",
    side: "head",
    startLine: located.line.line,
    endLine: located.line.line,
    hunkHeader: located.hunk.hunkHeader,
  };
}

function sourceEvidence(
  file: string,
  content: string | undefined,
  symbol: string | undefined,
  value: string,
): ChangeIntentEvidence {
  const lines = content?.split(/\r?\n/) ?? [];
  const line = symbol
    ? lines.findIndex((candidate) => candidate.includes(symbol)) + 1
    : 0;
  return {
    kind: "source",
    value,
    sourceRole: "product",
    file,
    symbol,
    relation: "supporting",
    side: "head",
    startLine: line > 0 ? line : undefined,
    endLine: line > 0 ? line : undefined,
  };
}

async function readSource(
  options: RuntimePrerequisiteAnalysisOptions,
  file: string,
): Promise<string | undefined> {
  const root = path.resolve(options.root);
  if (options.includeWorkingTree) {
    try {
      return await fs.readFile(path.join(root, file), "utf8");
    } catch {
      return undefined;
    }
  }
  const gitRoot = path.resolve(options.workspaceRoot ?? root);
  const scopePrefix = options.workspaceRoot
    ? toPosix(path.relative(gitRoot, root)).replace(/^\.\/+|\/+$/g, "")
    : "";
  const gitPath = scopePrefix ? `${scopePrefix}/${toPosix(file)}` : toPosix(file);
  return readFileAtRef(gitRoot, options.head, gitPath);
}

function isRoutableSurfaceFile(file: string): boolean {
  const normalized = toPosix(file);
  if (/(?:^|\/)pages\/(?:api\/|_app\.|_document\.)/i.test(normalized)) {
    return false;
  }
  return /(?:^|\/)app\/(?:.*\/)?page\.[cm]?[jt]sx?$/i.test(normalized) ||
    /(?:^|\/)pages\/.+\.[cm]?[jt]sx?$/i.test(normalized) ||
    /(?:^|\/)screens\/.+\.[cm]?[jt]sx?$/i.test(normalized) ||
    /(?:^|\/)routes\/.+\.[cm]?[jt]sx?$/i.test(normalized);
}

function routeSubject(file: string): string {
  const withoutExtension = path.posix.basename(file).replace(/\.[^.]+$/, "");
  if (withoutExtension !== "page" && withoutExtension !== "index") {
    return withoutExtension;
  }
  return path.posix.basename(path.posix.dirname(file));
}

function splitIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function titleCase(value: string): string {
  return splitIdentifier(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
