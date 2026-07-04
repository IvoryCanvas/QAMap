import { promises as fs } from "node:fs";
import path from "node:path";

const maxGraphFiles = 12000;
const maxSourceBytes = 300_000;
const defaultMaxHops = 2;
const maxImpactSurfaces = 6;
const maxExpandedImporters = 40;

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

interface ReverseImportIndex {
  importersOf: Map<string, Set<string>>;
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

// Per-process cache: safe because the CLI is one-shot per invocation. Callers that
// mutate source files and re-plan within one process will see a stale graph.
const indexCache = new Map<string, Promise<ReverseImportIndex>>();
const maxCachedIndexes = 8;

export async function buildReverseImportIndex(rootInput: string): Promise<ReverseImportIndex> {
  const root = path.resolve(rootInput);
  const cached = indexCache.get(root);
  if (cached) {
    return cached;
  }
  const pending = buildReverseImportIndexUncached(root);
  if (indexCache.size >= maxCachedIndexes) {
    indexCache.clear();
  }
  indexCache.set(root, pending);
  return pending;
}

async function buildReverseImportIndexUncached(root: string): Promise<ReverseImportIndex> {
  const { sourceFiles, packageJsonFiles } = await collectSourceFiles(root);
  const fileSet = new Set(sourceFiles);
  const tsconfigPaths = await readTsconfigPaths(root);
  const workspacePackages = await readWorkspacePackages(root, packageJsonFiles);
  const importersOf = new Map<string, Set<string>>();

  for (const file of sourceFiles) {
    let text: string;
    try {
      const stats = await fs.stat(path.join(root, file));
      if (stats.size > maxSourceBytes) {
        continue;
      }
      text = await fs.readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(importSpecifierMatcher)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const resolved = resolveImportSpecifier(specifier, file, fileSet, tsconfigPaths, workspacePackages);
      if (!resolved || resolved === file) {
        continue;
      }
      let importers = importersOf.get(resolved);
      if (!importers) {
        importers = new Set<string>();
        importersOf.set(resolved, importers);
      }
      importers.add(file);
    }
  }

  return { importersOf };
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

async function collectSourceFiles(root: string): Promise<{ sourceFiles: string[]; packageJsonFiles: string[] }> {
  const sourceFiles: string[] = [];
  const packageJsonFiles: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && sourceFiles.length < maxGraphFiles) {
    const relativeDir = queue.shift() as string;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (sourceFiles.length >= maxGraphFiles) {
        break;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(relativePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name === "package.json") {
        packageJsonFiles.push(relativePath);
        continue;
      }
      if (sourceExtensions.has(path.extname(entry.name))) {
        sourceFiles.push(relativePath);
      }
    }
  }
  return { sourceFiles, packageJsonFiles };
}

async function readWorkspacePackages(root: string, packageJsonFiles: string[]): Promise<WorkspacePackages> {
  const byName = new Map<string, string>();
  for (const file of packageJsonFiles.slice(0, 200)) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(root, file), "utf8")) as { name?: string };
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

async function readTsconfigPaths(root: string): Promise<TsconfigPaths> {
  const empty: TsconfigPaths = { baseUrl: "", patterns: [] };
  for (const candidate of ["tsconfig.json", "jsconfig.json"]) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(root, candidate), "utf8");
    } catch {
      continue;
    }
    try {
      const withoutComments = raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([}\]])/g, "$1");
      const parsed = JSON.parse(withoutComments) as {
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
