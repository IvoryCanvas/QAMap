import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import ts from "typescript";
import { parseDocument } from "yaml";
import { openLocalIndexCache } from "./import-index-cache.js";
import { comparePaths, createRepositoryTextReader, discoverRepositoryPaths } from "./repository-discovery.js";
import { collectSourceStructure, safeModule, safeRuntimeModule, safeSymbol, structureLimit, structurePolicy } from "./source-structure.js";
import type { SourceStructure } from "./source-structure.js";
import { createRepositoryModuleResolver } from "./repository-impact.js";

const excluded = new Set([".git", "node_modules", "vendor", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".qamap", ".worktrees"]);
const limits = { files: 12000, fileBytes: 300_000, metadataPerField: structureLimit };
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);
const safePath = (value: string): boolean => value.length > 0 && value.length <= 4096 && !path.posix.isAbsolute(value)
  && !value.includes("\\") && !value.includes("\0") && !value.split("/").some((part) => !part || part === ".." || part === ".");
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export interface RepositoryIndexBlock extends SourceStructure {
  file: string;
  hash: string;
  kind: "source" | "test" | "configuration" | "contract";
  contracts: Array<{ pointer: string; kind: "operation" | "response" | "schema" }>;
  validation: Array<{ name: string; hash: string }>;
  modules: Array<{ specifier: string; target: string }>;
  outputs: Array<{ specifier: string; target: string }>;
}
interface RepositorySnapshot { schema: 1; context: string; blocks: RepositoryIndexBlock[] }
export interface RepositoryEvidenceIndex {
  schemaVersion: 1;
  blocks: RepositoryIndexBlock[];
  coverage: {
    scope: "repository-evidence";
    snapshot: "working-tree";
    discovery: "git" | "filesystem" | "unavailable";
    inventoryFiles: number;
    indexedFiles: number;
    complete: boolean;
    inventoryComplete: boolean;
    fingerprint: string;
    limits: typeof limits;
    skipped: Array<{ path: string; reason: string }>;
    classifications: Record<string, number>;
  };
  reuse: {
    status: "cold" | "warm" | "incremental" | "rebuilt" | "disabled" | "unavailable";
    storage: "saved" | "unchanged" | "skipped" | "failed";
    reusedFiles: number;
    rebuiltFiles: number;
    changedFiles: string[];
    affectedFiles: string[];
    readFiles: number;
    readBytes: number;
  };
}

// A working-tree index cannot supply line evidence for a different committed tree.
export async function repositoryIndexMatchesRef(root: string, index: RepositoryEvidenceIndex, ref: string): Promise<boolean> {
  try {
    const { stdout: changed } = await execFileAsync("git", ["diff", "--name-only", "-z", ref, "--"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const { stdout: untracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const indexed = new Set(index.blocks.map((block) => block.file));
    return [...changed.split("\0"), ...untracked.split("\0")].filter(Boolean).every((file) =>
      !indexed.has(file) && !["source", "test", "configuration", "contract"].includes(classify(file)),
    );
  } catch { return false; }
}

function classify(file: string): RepositoryIndexBlock["kind"] | "documentation" | "generated" | "unsupported-language" | "non-source" {
  if (/(?:\.generated\.|\.min\.|(?:^|\/)generated\/|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$)/.test(file)) return "generated";
  if (/\.[cm]?[jt]sx?$/.test(file)) return /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ? "test" : "source";
  if (/(?:^|\/)(?:package|[jt]sconfig(?:\.[\w-]+)?)\.json$/.test(file) || /(?:^|\/)(?:qamap\.)?manifest\.(?:json|ya?ml)$/.test(file)) return "configuration";
  if (/\.(?:json|ya?ml)$/.test(file) && /(?:^|[/._-])(?:openapi|swagger|schema)(?:[/._-]|$)/i.test(file)) return "contract";
  if (/\.(?:md|mdx|txt|rst)$/.test(file)) return "documentation";
  if (/\.(?:py|go|rs|rb|php|java|kt|swift|dart|c|cpp|h|cs|vue|svelte)$/.test(file)) return "unsupported-language";
  return "non-source";
}

function metadata(file: string, text: string, kind: RepositoryIndexBlock["kind"]): RepositoryIndexBlock {
  try { return parseMetadata(file, text, kind); }
  catch {
    return { file, hash: digest(text), kind, declarations: [], imports: [], exports: [], references: [], tests: [], routes: [],
      contracts: [], validation: [], modules: [], outputs: [], gaps: [{ line: 1, kind: "parse-error" }, { line: 1, kind: "metadata-parser-failure" }] };
  }
}

function parseMetadata(file: string, text: string, kind: RepositoryIndexBlock["kind"]): RepositoryIndexBlock {
  const structure = kind === "source" || kind === "test" ? collectSourceStructure(file, text)
    : { declarations: [], imports: [], exports: [], references: [], tests: [], routes: [], gaps: [] };
  const block: RepositoryIndexBlock = { file, hash: digest(text), kind, ...structure, contracts: [], validation: [], modules: [], outputs: [] };
  if (kind !== "configuration" && kind !== "contract") return block;
  let value: unknown;
  try {
    if (/\.ya?ml$/.test(file)) {
      const document = parseDocument(text);
      if (document.errors.length) throw new Error("Invalid structured document");
      value = document.toJS({ maxAliasCount: 50 });
    } else if (/(?:^|\/)[jt]sconfig/.test(file)) {
      const parsed = ts.parseConfigFileTextToJson(file, text);
      if (parsed.error) throw new Error("Invalid compiler configuration");
      value = parsed.config;
    } else value = JSON.parse(text);
  } catch { block.gaps.push({ line: 1, kind: "parse-error" }); return block; }
  if (!isRecord(value)) { block.gaps.push({ line: 1, kind: "unsupported-configuration" }); return block; }
  if (path.posix.basename(file) === "package.json") {
    if (isRecord(value.scripts)) {
      for (const [name, command] of Object.entries(value.scripts)) {
        if (name.length <= 160 && /^(?:bench|build|check|lint|smoke|test|typecheck|validate|verify)(?::[\w-]+)*$/.test(name) && typeof command === "string") {
          block.validation.push({ name, hash: digest(command) });
        }
      }
    }
    if (typeof value.name === "string" && safeModule(value.name)) {
      const recordTarget = (specifier: string, target: unknown): void => {
        if (typeof target === "string" && /^[\w./*-]{1,512}$/.test(target) && target.startsWith("./") && !target.slice(2).split("/").includes("..")) {
          block.modules.push({ specifier, target: path.posix.join(path.posix.dirname(file), target) });
        } else if (isRecord(target)) {
          for (const condition of ["source", "types", "import", "default"]) {
            if (target[condition] !== undefined) recordTarget(specifier, target[condition]);
          }
          block.gaps.push({ line: 1, kind: "conditional-package-exports" });
        } else block.gaps.push({ line: 1, kind: "unsupported-package-export" });
      };
      if (typeof value.exports === "string" || (isRecord(value.exports) && !Object.keys(value.exports).some((key) => key.startsWith(".")))) {
        recordTarget(value.name, value.exports);
      } else if (isRecord(value.exports)) {
        for (const [key, target] of Object.entries(value.exports)) {
          if (key === "." || /^\.\/[\w./*-]+$/.test(key)) recordTarget(`${value.name}${key === "." ? "" : key.slice(1)}`, target);
        }
      } else {
        const entry = value.source ?? value.module ?? value.main;
        if (typeof entry === "string") recordTarget(value.name, entry.startsWith("./") ? entry : `./${entry}`);
        else block.gaps.push({ line: 1, kind: "package-entry-unspecified" });
      }
    }
  } else if (/(?:^|\/)[jt]sconfig/.test(file)) {
    if (value.extends) block.gaps.push({ line: 1, kind: "extended-compiler-config" });
    collectCompilerOutputs(block, value);
    if (isRecord(value.compilerOptions) && isRecord(value.compilerOptions.paths)) {
      const base = typeof value.compilerOptions.baseUrl === "string" ? value.compilerOptions.baseUrl : ".";
      for (const [specifier, targets] of Object.entries(value.compilerOptions.paths)) {
        if (!/^[\w@./*-]+$/.test(specifier) || !Array.isArray(targets)) continue;
        for (const target of targets) {
          if (typeof target !== "string" || !/^[\w./*-]+$/.test(target)) continue;
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), base, target));
          if (safePath(resolved)) block.modules.push({ specifier, target: resolved });
          else block.gaps.push({ line: 1, kind: "outside-repository-alias" });
        }
      }
    }
  } else if (kind === "configuration") block.gaps.push({ line: 1, kind: "validation-config-reference-only" });
  if (kind === "contract") {
    const pointer = (part: string): string => part.replace(/~/g, "~0").replace(/\//g, "~1");
    if ((typeof value.openapi === "string" || value.swagger === "2.0") && isRecord(value.paths)) {
      for (const [endpoint, methods] of Object.entries(value.paths)) {
        if (!isRecord(methods)) continue;
        for (const [method, operation] of Object.entries(methods)) {
          if (!/^(?:get|post|put|patch|delete|options|head|trace)$/.test(method) || !isRecord(operation)) continue;
          const operationPointer = `/paths/${pointer(endpoint)}/${method}`;
          if (operationPointer.length > 4000 || /[\u0000-\u001f]/.test(operationPointer)) {
            block.gaps.push({ line: 1, kind: "unsupported-contract-pointer" }); continue;
          }
          block.contracts.push({ pointer: operationPointer, kind: "operation" });
          if (isRecord(operation.responses)) for (const status of Object.keys(operation.responses)) {
            if (/^(?:[1-5][0-9X]{2}|default)$/.test(status)) block.contracts.push({ pointer: `${operationPointer}/responses/${status}`, kind: "response" });
          }
        }
      }
    } else if (typeof value.$schema === "string") block.contracts.push({ pointer: "", kind: "schema" });
    else block.gaps.push({ line: 1, kind: "unrecognized-contract" });
  }
  for (const field of ["contracts", "validation", "modules", "outputs"] as const) if (block[field].length > structureLimit) {
    block[field].splice(structureLimit);
    block.gaps.push({ line: 1, kind: `metadata-limit:${field}` });
  }
  if (block.gaps.length > structureLimit) block.gaps = [
    { line: 1, kind: "metadata-limit:gaps" }, ...block.gaps.slice(0, structureLimit - 1),
  ];
  return block;
}

function collectCompilerOutputs(block: RepositoryIndexBlock, config: Record<string, unknown>): void {
  const options = config.compilerOptions;
  if (!isRecord(options) || typeof options.rootDir !== "string" || typeof options.outDir !== "string") return;
  const directory = path.posix.dirname(block.file);
  const root = path.posix.normalize(path.posix.join(directory, options.rootDir));
  const output = path.posix.normalize(path.posix.join(directory, options.outDir));
  if (![options.rootDir, options.outDir].every((value) => /^[\w./-]+$/.test(value) && !path.posix.isAbsolute(value))
    || (root !== "." && !safePath(root)) || !safePath(output)) {
    block.gaps.push({ line: 1, kind: "unsupported-compiler-output" }); return;
  }
  const extensions = ["ts", "tsx", "mts", "cts"];
  const includes = config.include;
  const selected = new Set<string>();
  let unsupported = Boolean(config.extends || config.references || config.files || options.rootDirs || options.outFile
    || options.noEmit || options.emitDeclarationOnly || options.allowJs || options.noResolve);
  unsupported ||= ts.convertCompilerOptionsFromJson(options, directory).errors.length > 0;
  unsupported ||= config.exclude !== undefined && (!Array.isArray(config.exclude) || config.exclude.length > 0);
  if (includes === undefined) extensions.forEach((extension) => selected.add(extension));
  else if (Array.isArray(includes)) {
    for (const include of includes) {
      if (typeof include !== "string" || !/^[\w./*-]+$/.test(include) || path.posix.isAbsolute(include)) { unsupported = true; continue; }
      const normalized = path.posix.normalize(path.posix.join(directory, include));
      if (normalized === root || normalized === path.posix.join(root, "**/*")) extensions.forEach((extension) => selected.add(extension));
      else {
        const extension = extensions.find((suffix) => normalized === path.posix.join(root, `**/*.${suffix}`));
        if (extension) selected.add(extension); else unsupported = true;
      }
    }
  } else unsupported = true;
  // Only whole source-tree includes are modeled. Filters and inherited build settings remain explicit boundaries.
  if (unsupported) {
    block.gaps.push({ line: 1, kind: "unsupported-compiler-output" });
    extensions.forEach((extension) => selected.add(extension));
  }
  for (const extension of selected) {
    const emitted = extension === "mts" ? "mjs" : extension === "cts" ? "cjs"
      : extension === "tsx" && options.jsx === "preserve" ? "jsx" : "js";
    block.outputs.push({ specifier: path.posix.join(output, `*.${emitted}`), target: path.posix.join(root, `*.${extension}`) });
  }
}

function validSnapshot(value: unknown): value is RepositorySnapshot {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "blocks,context,schema" || value.schema !== 1
    || typeof value.context !== "string" || !/^[a-f0-9]{64}$/.test(value.context) || !Array.isArray(value.blocks) || value.blocks.length > limits.files) return false;
  const files = new Set<string>();
  const fields: Record<string, Record<string, (value: unknown) => boolean>> = {
    declarations: { name: symbol, line: lineNumber, endLine: lineNumber, kind: enumOf("function", "variable", "class", "type"),
      "runtimeLoads?": value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(entry => isRecord(entry)
        && Object.keys(entry).sort().join(",") === "line,parameter" && lineNumber(entry.line)
        && Number.isInteger(entry.parameter) && Number(entry.parameter) >= 0 && Number(entry.parameter) < 16) },
    imports: { module: moduleName, imported: symbol, local: symbol, line: lineNumber },
    exports: { local: symbol, exported: symbol, line: lineNumber, "module?": moduleName },
    references: { name: symbol, line: lineNumber, owner: symbol, "member?": symbol, "registration?": (entry) => entry === true,
      "callArguments?": value => Array.isArray(value) && value.length <= 16
        && value.every(entry => entry === null || typeof entry === "string" && safeRuntimeModule(entry)) },
    tests: { line: lineNumber, kind: enumOf("assertion", "test-declaration") },
    routes: { line: lineNumber, kind: enumOf(...["get", "post", "put", "patch", "delete", "options", "head", "all", "use"].map((name) => `registration-candidate:${name}`)), "handler?": symbol },
    gaps: { line: lineNumber, kind: (entry) => typeof entry === "string" && /^[a-z-]+(?::[a-z]+)?$/.test(entry) && entry.length < 80 },
    contracts: { pointer: (entry) => typeof entry === "string" && entry.length <= 4096 && !/[\u0000-\u001f]/.test(entry), kind: enumOf("operation", "response", "schema") },
    validation: { name: (entry) => typeof entry === "string" && /^[\w:-]{1,160}$/.test(entry), hash: hashValue },
    modules: { specifier: (entry) => typeof entry === "string" && /^[\w@./*-]{1,512}$/.test(entry), target: (entry) => typeof entry === "string" && safePath(entry) },
    outputs: { specifier: (entry) => typeof entry === "string" && safePath(entry), target: (entry) => typeof entry === "string" && safePath(entry) },
  };
  for (const block of value.blocks) {
    if (!isRecord(block) || Object.keys(block).sort().join(",") !== [...Object.keys(fields), "file", "hash", "kind"].sort().join(",")
      || typeof block.file !== "string" || !safePath(block.file) || files.has(block.file) || !hashValue(block.hash)
      || !enumOf("source", "test", "configuration", "contract")(block.kind)) return false;
    files.add(block.file);
    for (const [field, shape] of Object.entries(fields)) {
      const items = block[field];
      if (!Array.isArray(items) || items.length > structureLimit) return false;
      for (const item of items) {
        if (!isRecord(item) || Object.keys(item).some((key) => !(key in shape) && !(`${key}?` in shape))) return false;
        for (const [key, validate] of Object.entries(shape)) {
          const optional = key.endsWith("?");
          const fieldName = optional ? key.slice(0, -1) : key;
          if (!(optional && item[fieldName] === undefined) && !validate(item[fieldName])) return false;
        }
      }
    }
  }
  return true;
}
const lineNumber = (value: unknown): boolean => Number.isInteger(value) && (value as number) > 0 && (value as number) <= limits.fileBytes + 1;
const symbol = (value: unknown): boolean => typeof value === "string" && safeSymbol(value);
const moduleName = (value: unknown): boolean => typeof value === "string" && safeModule(value);
const hashValue = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const enumOf = (...values: string[]) => (value: unknown): boolean => typeof value === "string" && values.includes(value);

export async function buildRepositoryEvidenceIndex(rootInput: string, options: { cacheDirectory?: string | false } = {}): Promise<RepositoryEvidenceIndex> {
  const root = path.resolve(rootInput);
  const inventory = await discoverRepositoryPaths(root, excluded);
  const readerGaps = [...inventory.skipped];
  const read = createRepositoryTextReader(root, readerGaps, limits.fileBytes);
  const skipped: RepositoryEvidenceIndex["coverage"]["skipped"] = [];
  const classifications: Record<string, number> = {};
  const context = digest(JSON.stringify({ structurePolicy, limits, policy: "repository-metadata-v2" }));
  const cache = await openLocalIndexCache(root, "repository", validSnapshot,
    process.env.QAMAP_REPOSITORY_CACHE === "off" ? false : options.cacheDirectory, inventory.inventoryComplete && inventory.discovery !== "unavailable");
  const previous = cache.previous;
  const oldBlocks = new Map(previous?.blocks.map((block) => [block.file, block]));
  const blocks: RepositoryIndexBlock[] = [];
  let reusedFiles = 0;
  let readBytes = 0;
  for (const file of inventory.files) {
    if (file.split("/").some((part) => excluded.has(part) || (part.startsWith(".") && part !== ".github"))) {
      skipped.push({ path: file, reason: "excluded-directory" }); continue;
    }
    const kind = classify(file);
    classifications[kind] = (classifications[kind] ?? 0) + 1;
    if (kind === "documentation" || kind === "generated" || kind === "unsupported-language" || kind === "non-source") {
      skipped.push({ path: file, reason: kind }); continue;
    }
    if (blocks.length >= limits.files) { skipped.push({ path: file, reason: "source-limit" }); continue; }
    const text = await read(file);
    if (text === undefined) continue;
    readBytes += Buffer.byteLength(text);
    const old = oldBlocks.get(file);
    if (previous?.context === context && old?.hash === digest(text) && old.kind === kind) {
      blocks.push(old); reusedFiles++;
    } else blocks.push(metadata(file, text, kind));
  }
  skipped.push(...readerGaps);
  for (const block of blocks) for (const gap of block.gaps) skipped.push({ path: `${block.file}:${gap.line}`, reason: gap.kind });
  skipped.sort((a, b) => comparePaths(a.path, b.path) || comparePaths(a.reason, b.reason));
  const current = new Map(blocks.map((block) => [block.file, block]));
  const changedFiles = previous ? [...new Set([...oldBlocks.keys(), ...current.keys()])]
    .filter((file) => oldBlocks.get(file)?.hash !== current.get(file)?.hash).sort(comparePaths) : [];
  const affected = new Set<string>();
  // Configuration changes invalidate relationships, not unchanged syntax blocks.
  const configChanged = changedFiles.some((file) => (current.get(file) ?? oldBlocks.get(file))?.kind === "configuration");
  const reverse = new Map<string, Set<string>>();
  for (const snapshot of [[...oldBlocks.values()], blocks]) {
    const resolve = createRepositoryModuleResolver(snapshot);
    for (const block of snapshot) {
    if (configChanged && (block.imports.length || block.exports.some((entry) => entry.module))) affected.add(block.file);
    for (const entry of [...block.imports, ...block.exports]) {
      if (!entry.module) continue;
      const resolution = resolve(block.file, entry.module);
      if (resolution.reason || resolution.candidates.length !== 1) continue;
      const target = resolution.candidates[0];
      const importers = reverse.get(target) ?? new Set<string>();
      importers.add(block.file); reverse.set(target, importers);
    }
    }
  }
  const queue = [...changedFiles, ...affected];
  const visited = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor++) for (const importer of reverse.get(queue[cursor]) ?? []) {
    if (visited.has(importer)) continue;
    visited.add(importer); queue.push(importer); affected.add(importer);
  }
  const fingerprint = digest(JSON.stringify({ context, files: inventory.files, hashes: blocks.map((block) => [block.file, block.hash]), skipped,
    discovery: inventory.discovery, inventoryComplete: inventory.inventoryComplete }));
  const status = cache.state === "disabled" || cache.state === "unavailable" ? cache.state
    : (previous && previous.context !== context) || cache.state === "invalid-cache" || cache.state === "expired-cache" ? "rebuilt"
      : !previous ? "cold" : changedFiles.length ? "incremental" : "warm";
  return { schemaVersion: 1, blocks, coverage: {
    scope: "repository-evidence", snapshot: "working-tree", discovery: inventory.discovery, inventoryFiles: inventory.files.length,
    indexedFiles: blocks.length, complete: inventory.inventoryComplete && skipped.length === 0, inventoryComplete: inventory.inventoryComplete,
    fingerprint, limits, skipped, classifications,
  }, reuse: { status, storage: await cache.save({ schema: 1, context, blocks }), reusedFiles, rebuiltFiles: blocks.length - reusedFiles,
    changedFiles, affectedFiles: [...affected].filter((file) => current.has(file)).sort(comparePaths), readFiles: blocks.length, readBytes } };
}
