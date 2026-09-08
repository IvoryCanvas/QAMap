import { createHash } from "node:crypto";
import path from "node:path";
import { comparePaths, createRepositoryTextReader, discoverRepositoryPaths } from "./repository-discovery.js";
import type { DiscoveryGap } from "./repository-discovery.js";

const maxGraphFiles = 12000;
const maxSourceBytes = 300_000;
const defaultMaxHops = 2;
const maxImpactSurfaces = 6;
const maxExpandedImporters = 40;
const maxExpandedImports = 80;

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"]);
const resolvableExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];

const ignoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".expo",
  ".worktree",
  ".worktrees",
  "vendor",
]);

export interface ImportImpact {
  surface: string;
  changedFile: string;
  hops: number;
  chain: string[];
}

export interface ChangedFileExpansion {
  files: string[];
  via: Record<string, string[]>;
}

export interface ImportDiscoveryCoverage {
  scope: "import-graph";
  snapshot: "working-tree";
  discovery: "git" | "filesystem" | "unavailable";
  inventoryComplete: boolean;
  inventoryFiles: number;
  parsedSources: number;
  fingerprint: string;
  limits: { sourceFiles: number; sourceBytes: number; packageFiles: number; traversalHops: number; impactSurfaces: number };
  skipped: DiscoveryGap[];
}

export interface ReverseImportIndex {
  importersOf: Map<string, Set<string>>;
  importsOf: Map<string, Set<string>>;
  coverage: ImportDiscoveryCoverage;
}

interface WorkspacePackages {
  byName: Map<string, string>;
}

interface TsconfigPaths {
  baseUrl: string;
  patterns: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

const importSpecifierMatcher =
  /(?:import|export)\s+(?:[\s\S]*?from\s+)?["']([^"'\n]+)["']|require\(\s*["']([^"'\n]+)["']\s*\)|import\(\s*["']([^"'\n]+)["']\s*\)/g;

export async function buildReverseImportIndex(rootInput: string): Promise<ReverseImportIndex> {
  const root = path.resolve(rootInput);
  const inventory = await discoverRepositoryPaths(root, ignoredDirectories);
  const skipped = [...inventory.skipped];
  const readable = createRepositoryTextReader(root, skipped, maxSourceBytes);
  const fingerprints: Array<[string, string]> = [];
  const readText = async (file: string): Promise<string | undefined> => {
    const text = await readable(file);
    if (text !== undefined) fingerprints.push([file, createHash("sha256").update(text).digest("hex")]);
    return text;
  };
  const sourceFiles: string[] = [];
  const packageJsonFiles: string[] = [];
  for (const file of inventory.files) {
    if (file.split("/").slice(0, -1).some((part) => ignoredDirectories.has(part) || part.startsWith("."))) {
      skipped.push({ path: file, reason: "excluded-directory" });
    } else if (path.posix.basename(file) === "package.json") {
      if (packageJsonFiles.length < 200) packageJsonFiles.push(file);
      else skipped.push({ path: file, reason: "package-limit" });
    } else if (sourceExtensions.has(path.extname(file))) {
      sourceFiles.push(file);
    } else if (file !== "tsconfig.json" && file !== "jsconfig.json") {
      skipped.push({ path: file, reason: /\.(?:py|go|rs|rb|php|java|kt|swift|dart|c|cpp|h|cs)$/i.test(file)
        ? "unsupported-language" : "non-source" });
    }
  }
  const fileSet = new Set(sourceFiles);
  const tsconfigPaths = await readTsconfigPaths(inventory.files, readText);
  const workspacePackages = await readWorkspacePackages(packageJsonFiles, readText);
  const importersOf = new Map<string, Set<string>>();
  const importsOf = new Map<string, Set<string>>();
  let parsedSources = 0;

  for (const file of sourceFiles) {
    if (parsedSources >= maxGraphFiles) {
      skipped.push({ path: file, reason: "source-limit" });
      continue;
    }
    const text = await readText(file);
    if (text === undefined) continue;
    parsedSources++;
    for (const match of text.matchAll(importSpecifierMatcher)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const resolved = resolveImportSpecifier(specifier, file, fileSet, tsconfigPaths, workspacePackages);
      if (!resolved || resolved === file) {
        continue;
      }
      let imports = importsOf.get(file);
      if (!imports) {
        imports = new Set<string>();
        importsOf.set(file, imports);
      }
      imports.add(resolved);
      let importers = importersOf.get(resolved);
      if (!importers) {
        importers = new Set<string>();
        importersOf.set(resolved, importers);
      }
      importers.add(file);
    }
  }

  skipped.sort((left, right) => comparePaths(left.path, right.path) || comparePaths(left.reason, right.reason));
  const limits = { sourceFiles: maxGraphFiles, sourceBytes: maxSourceBytes, packageFiles: 200,
    traversalHops: defaultMaxHops, impactSurfaces: maxImpactSurfaces };
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1, discovery: inventory.discovery, inventoryComplete: inventory.inventoryComplete,
    files: inventory.files, contents: fingerprints.sort((a, b) => comparePaths(a[0], b[0])), skipped, limits,
  })).digest("hex");
  return { importersOf, importsOf, coverage: {
    scope: "import-graph", snapshot: "working-tree", discovery: inventory.discovery,
    inventoryComplete: inventory.inventoryComplete, inventoryFiles: inventory.files.length,
    parsedSources, fingerprint, limits, skipped,
  } };
}

export function findImportingSurfaces(
  index: ReverseImportIndex,
  changedFiles: string[],
  isSurface: (file: string) => boolean,
  maxHops: number = defaultMaxHops,
): ImportImpact[] {
  const impacts: ImportImpact[] = [];
  const seenSurfaces = new Set<string>();

  for (const changedFile of changedFiles) {
    if (isSurface(changedFile)) {
      continue;
    }
    for (const reached of walkImporters(index, changedFile, maxHops)) {
      if (!isSurface(reached.file) || seenSurfaces.has(reached.file)) {
        continue;
      }
      seenSurfaces.add(reached.file);
      impacts.push({
        surface: reached.file,
        changedFile,
        hops: reached.hops,
        chain: reached.chain,
      });
      if (impacts.length >= maxImpactSurfaces) {
        return impacts;
      }
    }
  }
  return impacts;
}

export async function expandChangedFilesWithImporters(
  rootInput: string,
  changedFiles: string[],
  maxHops: number = defaultMaxHops,
): Promise<ChangedFileExpansion> {
  if (changedFiles.length === 0) {
    return { files: [], via: {} };
  }
  const index = await buildReverseImportIndex(rootInput);
  const via: Record<string, string[]> = {};
  const expanded: string[] = [...changedFiles];
  const known = new Set(changedFiles);

  for (const changedFile of changedFiles) {
    for (const reached of walkImporters(index, changedFile, maxHops)) {
      if (known.has(reached.file)) {
        continue;
      }
      known.add(reached.file);
      expanded.push(reached.file);
      via[reached.file] = reached.chain;
      if (expanded.length - changedFiles.length >= maxExpandedImporters) {
        return { files: expanded, via };
      }
    }
  }
  return { files: expanded, via };
}

export async function expandFilesWithImports(
  rootInput: string,
  files: string[],
  maxHops: number = defaultMaxHops,
): Promise<ChangedFileExpansion> {
  if (files.length === 0) {
    return { files: [], via: {} };
  }
  const index = await buildReverseImportIndex(rootInput);
  const via: Record<string, string[]> = {};
  const expanded = [...files];
  const known = new Set(files);

  for (const file of files) {
    for (const reached of walkImports(index, file, maxHops)) {
      if (known.has(reached.file)) {
        continue;
      }
      known.add(reached.file);
      expanded.push(reached.file);
      via[reached.file] = reached.chain;
      if (expanded.length - files.length >= maxExpandedImports) {
        return { files: expanded, via };
      }
    }
  }
  return { files: expanded, via };
}

function* walkImporters(
  index: ReverseImportIndex,
  startFile: string,
  maxHops: number,
): Generator<{ file: string; hops: number; chain: string[] }> {
  const visited = new Set<string>([startFile]);
  let frontier: Array<{ file: string; chain: string[] }> = [{ file: startFile, chain: [startFile] }];

  for (let hop = 1; hop <= maxHops; hop += 1) {
    const nextFrontier: Array<{ file: string; chain: string[] }> = [];
    for (const entry of frontier) {
      for (const importer of index.importersOf.get(entry.file) ?? []) {
        if (visited.has(importer)) {
          continue;
        }
        visited.add(importer);
        const chain = [...entry.chain, importer];
        yield { file: importer, hops: hop, chain };
        nextFrontier.push({ file: importer, chain });
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) {
      return;
    }
  }
}

function* walkImports(
  index: ReverseImportIndex,
  startFile: string,
  maxHops: number,
): Generator<{ file: string; hops: number; chain: string[] }> {
  const visited = new Set<string>([startFile]);
  let frontier: Array<{ file: string; chain: string[] }> = [{ file: startFile, chain: [startFile] }];

  for (let hop = 1; hop <= maxHops; hop += 1) {
    const nextFrontier: Array<{ file: string; chain: string[] }> = [];
    for (const entry of frontier) {
      for (const imported of index.importsOf.get(entry.file) ?? []) {
        if (visited.has(imported)) {
          continue;
        }
        visited.add(imported);
        const chain = [...entry.chain, imported];
        yield { file: imported, hops: hop, chain };
        nextFrontier.push({ file: imported, chain });
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) {
      return;
    }
  }
}

async function readWorkspacePackages(
  packageJsonFiles: string[], readText: (file: string) => Promise<string | undefined>,
): Promise<WorkspacePackages> {
  const byName = new Map<string, string>();
  for (const file of packageJsonFiles.slice(0, 200)) {
    try {
      const parsed = JSON.parse(await readText(file) ?? "") as { name?: string };
      const directory = path.posix.dirname(toPosix(file));
      if (parsed.name && directory !== ".") {
        byName.set(parsed.name, directory);
      }
    } catch {
      continue;
    }
  }
  return { byName };
}

async function readTsconfigPaths(
  files: string[], readText: (file: string) => Promise<string | undefined>,
): Promise<TsconfigPaths> {
  const empty: TsconfigPaths = { baseUrl: "", patterns: [] };
  for (const candidate of ["tsconfig.json", "jsconfig.json"]) {
    let raw: string;
    try {
      if (!files.includes(candidate)) continue;
      const text = await readText(candidate);
      if (text === undefined) continue;
      raw = text;
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(raw)) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const baseUrl = normalizeRelativePath(parsed.compilerOptions?.baseUrl ?? "");
      const patterns: TsconfigPaths["patterns"] = [];
      for (const [pattern, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
        const starIndex = pattern.indexOf("*");
        patterns.push({
          prefix: starIndex === -1 ? pattern : pattern.slice(0, starIndex),
          suffix: starIndex === -1 ? "" : pattern.slice(starIndex + 1),
          targets: targets.map((target) => normalizeRelativePath(path.posix.join(baseUrl, target))),
        });
      }
      return { baseUrl, patterns };
    } catch {
      return empty;
    }
  }
  return empty;
}

function stripJsonCommentsAndTrailingCommas(raw: string): string {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        withoutComments += char;
      } else {
        withoutComments += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        withoutComments += "  ";
        index += 1;
      } else {
        withoutComments += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (inString) {
      withoutComments += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      withoutComments += "  ";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      withoutComments += "  ";
      index += 1;
      continue;
    }
    withoutComments += char;
  }

  let result = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (/\s/.test(withoutComments[cursor] ?? "")) cursor += 1;
      if (withoutComments[cursor] === "}" || withoutComments[cursor] === "]") {
        continue;
      }
    }
    result += char;
  }
  return result;
}

function resolveImportSpecifier(
  specifier: string | undefined,
  importerFile: string,
  fileSet: Set<string>,
  tsconfigPaths: TsconfigPaths,
  workspacePackages: WorkspacePackages,
): string | undefined {
  if (!specifier || specifier.startsWith("http:") || specifier.startsWith("https:")) {
    return undefined;
  }
  if (specifier.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(importerFile)), specifier));
    return probeFile(base, fileSet);
  }
  for (const pattern of tsconfigPaths.patterns) {
    if (!specifier.startsWith(pattern.prefix)) {
      continue;
    }
    if (pattern.suffix && !specifier.endsWith(pattern.suffix)) {
      continue;
    }
    const middle = specifier.slice(pattern.prefix.length, pattern.suffix ? -pattern.suffix.length : undefined);
    for (const target of pattern.targets) {
      const candidate = normalizeRelativePath(target.replace("*", middle));
      const resolved = probeFile(candidate, fileSet);
      if (resolved) {
        return resolved;
      }
    }
  }
  return resolveWorkspaceSpecifier(specifier, fileSet, workspacePackages);
}

function resolveWorkspaceSpecifier(
  specifier: string,
  fileSet: Set<string>,
  workspacePackages: WorkspacePackages,
): string | undefined {
  const slashIndex = specifier.startsWith("@") ? specifier.indexOf("/", specifier.indexOf("/") + 1) : specifier.indexOf("/");
  const packageName = slashIndex === -1 ? specifier : specifier.slice(0, slashIndex);
  const packageDir = workspacePackages.byName.get(packageName);
  if (!packageDir) {
    return undefined;
  }
  const remainder = slashIndex === -1 ? "" : specifier.slice(slashIndex + 1);
  const candidates = remainder
    ? [`${packageDir}/${remainder}`, `${packageDir}/src/${remainder}`]
    : [`${packageDir}/index`, `${packageDir}/src/index`];
  for (const candidate of candidates) {
    const resolved = probeFile(candidate, fileSet);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function probeFile(baseCandidate: string, fileSet: Set<string>): string | undefined {
  const candidate = normalizeRelativePath(baseCandidate);
  if (!candidate) {
    return undefined;
  }
  if (fileSet.has(candidate)) {
    return candidate;
  }
  const withoutJsExtension = candidate.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
  for (const base of withoutJsExtension === candidate ? [candidate] : [candidate, withoutJsExtension]) {
    for (const extension of resolvableExtensions) {
      if (fileSet.has(`${base}${extension}`)) {
        return `${base}${extension}`;
      }
    }
    for (const extension of resolvableExtensions) {
      if (fileSet.has(`${base}/index${extension}`)) {
        return `${base}/index${extension}`;
      }
    }
  }
  return undefined;
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosix(value)).replace(/^\.\/?/, "");
  return normalized === "." ? "" : normalized;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
