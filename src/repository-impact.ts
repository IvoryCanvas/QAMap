import path from "node:path";
import { isBuiltin } from "node:module";
import { comparePaths } from "./repository-discovery.js";
import type { RepositoryEvidenceIndex, RepositoryIndexBlock } from "./repository-index.js";

export interface ModuleResolution {
  candidates: string[];
  reason?: string;
  compiler?: string;
  excluded?: Array<{ path: string; reason: string }>;
}
export interface ImpactStep {
  file: string;
  line: number;
  symbol: string;
  changedLine?: number;
  relation: "changed-declaration" | "reference" | "export" | "import" | "reexport" | "test-reference" | "registration-candidate" | "compiler-mapping";
}
export interface RepositoryImpact {
  status: "draft";
  execution: "not-run";
  paths: Array<{ changedFile: string; changedSymbol: string; endpoint: "test-reference" | "registration-candidate"; evidence: ImpactStep[] }>;
  boundaries: Array<{ file: string; line?: number; symbol?: string; module?: string; target?: string; reason: string }>;
  visitedStates: number;
  limits: { states: number; paths: number; pathSteps: number };
  omittedPaths: number;
}

export function createRepositoryModuleResolver(
  blocks: RepositoryIndexBlock[], skipped: RepositoryEvidenceIndex["coverage"]["skipped"] = [],
): (file: string, module: string) => ModuleResolution {
  const files = new Set(blocks.filter((block) => block.kind === "source" || block.kind === "test").map((block) => block.file));
  const packages = blocks.filter((block) => path.posix.basename(block.file) === "package.json");
  const configs = blocks.filter((block) => /(?:^|\/)[jt]sconfig\.json$/.test(block.file));
  const probePaths = (candidate: string): string[] => {
    const normalized = path.posix.normalize(candidate);
    if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return [];
    const extension = path.posix.extname(normalized);
    const substitutions: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
    if (extension) return [normalized, ...(substitutions[extension] ?? []).map((suffix) => normalized.slice(0, -extension.length) + suffix)];
    const base = normalized;
    return [...new Set([base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((extension) => [`${base}${extension}`, `${base}/index${extension}`])])];
  };
  const probe = (candidate: string): string[] => files.has(path.posix.normalize(candidate))
    ? [path.posix.normalize(candidate)] : probePaths(candidate).filter((file) => files.has(file));
  const skippedByPath = new Map<string, typeof skipped>();
  for (const gap of skipped) skippedByPath.set(gap.path, [...(skippedByPath.get(gap.path) ?? []), gap]);
  const exclusions = (targets: string[]): Array<{ path: string; reason: string }> => {
    const matches = new Map<string, typeof skipped[number]>();
    for (const target of targets) {
      const parts = target.split("/");
      for (let end = 1; end <= parts.length; end++) for (const gap of skippedByPath.get(parts.slice(0, end).join("/")) ?? []) {
        matches.set(`${gap.path}:${gap.reason}`, gap);
      }
    }
    return [...matches.values()].sort((a, b) => comparePaths(a.path, b.path) || comparePaths(a.reason, b.reason));
  };
  const withExclusions = (resolution: ModuleResolution, targets: string[]): ModuleResolution => {
    const excluded = exclusions(targets.flatMap((target) => files.has(path.posix.normalize(target)) ? [path.posix.normalize(target)] : probePaths(target)));
    return excluded.length ? { ...resolution, reason: resolution.candidates.length > 1 ? resolution.reason : "index-excluded-module", excluded } : resolution;
  };
  const matchMapping = (specifier: string, target: string, module: string): string | undefined => {
    if (!specifier.includes("*")) return module === specifier ? target : undefined;
    const [prefix, suffix, extra] = specifier.split("*");
    if (extra !== undefined || !module.startsWith(prefix) || !module.endsWith(suffix) || module.length < prefix.length + suffix.length) return undefined;
    return target.replace("*", module.slice(prefix.length, suffix ? -suffix.length : undefined));
  };
  const outputMappings = blocks.flatMap((config) => (config.outputs ?? []).map((mapping) => ({ config, mapping })));
  const compiled = (output: string): ModuleResolution | undefined => {
    const mappings = outputMappings.flatMap(({ config, mapping }) => {
      const target = matchMapping(mapping.specifier, mapping.target, output);
      return target === undefined ? [] : [{ config, target }];
    });
    if (!mappings.length) return undefined;
    const candidates = [...new Set(mappings.flatMap(({ target }) => probe(target)))].filter((file) => !/\.d\.[cm]?ts$/.test(file)).sort(comparePaths);
    const configurations = [...new Set(mappings.map(({ config }) => config.file))];
    const unsupported = mappings.some(({ config }) => config.gaps.some((gap) =>
      gap.kind === "unsupported-compiler-output" || gap.kind === "parse-error" || gap.kind === "extended-compiler-config"));
    const reason = configurations.length > 1 ? "ambiguous-compiler-output" : unsupported ? "unsupported-compiler-output"
      : candidates.length > 1 ? "ambiguous-compiled-source" : !candidates.length ? "unindexed-compiled-source" : undefined;
    const resolution = { candidates, compiler: configurations[0], ...(reason ? { reason } : {}) };
    return unsupported || configurations.length > 1 ? resolution : withExclusions(resolution, mappings.map(({ target }) => target));
  };
  return (file, module) => {
    // Runtime internals are outside the repository graph, not missing local source.
    if (module.startsWith("node:")) return { candidates: [],
      reason: isBuiltin(module) ? "node-builtin-outside-repository" : "unresolved-node-module" };
    if (module.startsWith(".")) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), module));
      const candidates = probe(target);
      if (!candidates.length && !target.startsWith("../") && !path.posix.isAbsolute(target)) {
        const mapping = compiled(target);
        if (mapping) return mapping;
      }
      return withExclusions({ candidates, ...(candidates.length !== 1 ? { reason: candidates.length ? "ambiguous-module" : "unresolved-relative-module" } : {}) }, [target]);
    }
    const scopedConfigs = configs.filter((config) => path.posix.dirname(config.file) === "." || file.startsWith(`${path.posix.dirname(config.file)}/`))
      .sort((a, b) => b.file.split("/").length - a.file.split("/").length || comparePaths(a.file, b.file));
    const nearest = scopedConfigs[0];
    if (nearest && scopedConfigs[1] && path.posix.dirname(nearest.file) === path.posix.dirname(scopedConfigs[1].file)) {
      const candidates = [...new Set(scopedConfigs.filter((config) => path.posix.dirname(config.file) === path.posix.dirname(nearest.file))
        .flatMap((config) => config.modules.flatMap((mapping) => {
          const target = matchMapping(mapping.specifier, mapping.target, module);
          return target === undefined ? [] : probe(target);
        })))].sort(comparePaths);
      return { candidates, reason: "ambiguous-compiler-config" };
    }
    if (nearest) {
      const mappings = nearest.modules.filter((mapping) => matchMapping(mapping.specifier, mapping.target, module) !== undefined);
      if (mappings.length) {
        const specificity = Math.max(...mappings.map((mapping) => mapping.specifier.includes("*") ? mapping.specifier.indexOf("*") : 10000));
        const candidates = [...new Set(mappings.filter((mapping) => (mapping.specifier.includes("*") ? mapping.specifier.indexOf("*") : 10000) === specificity)
          .flatMap((mapping) => probe(matchMapping(mapping.specifier, mapping.target, module)!)))].sort(comparePaths);
        return withExclusions({ candidates, ...(candidates.length !== 1 ? { reason: candidates.length ? "ambiguous-alias" : "unresolved-alias" } : {}) },
          mappings.filter((mapping) => (mapping.specifier.includes("*") ? mapping.specifier.indexOf("*") : 10000) === specificity)
            .map((mapping) => matchMapping(mapping.specifier, mapping.target, module)!));
      }
      if (nearest.gaps.some((gap) => gap.kind === "extended-compiler-config")) return { candidates: [], reason: "extended-compiler-config" };
    }
    const mappings = packages.flatMap((block) => block.modules).filter((mapping) => matchMapping(mapping.specifier, mapping.target, module) !== undefined);
    const exact = mappings.filter((mapping) => !mapping.specifier.includes("*"));
    const selected = exact.length ? exact : mappings;
    const targets = selected.map((mapping) => probe(matchMapping(mapping.specifier, mapping.target, module)!));
    const candidates = [...new Set(targets.flat())].sort(comparePaths);
    const conditional = packages.some((block) => block.modules.some((mapping) => selected.includes(mapping))
      && block.gaps.some((gap) => gap.kind === "conditional-package-exports" || gap.kind === "unsupported-package-export"));
    const reason = candidates.length > 1 ? "ambiguous-package-export" : conditional ? "conditional-package-export"
      : targets.some((entries) => !entries.length) ? "unindexed-package-export" : !candidates.length ? "external-or-unresolved-package" : undefined;
    const resolution = { candidates, ...(reason ? { reason } : {}) };
    return conditional ? resolution : withExclusions(resolution, selected.map((mapping) => matchMapping(mapping.specifier, mapping.target, module)!));
  };
}

export function traceRepositoryImpact(
  index: RepositoryEvidenceIndex, changes: Array<{ file: string; lines?: number[] }>,
  options: { maxStates?: number; maxPaths?: number; maxPathSteps?: number } = {},
): RepositoryImpact {
  const limits = { states: bounded(options.maxStates, 4000, 20000), paths: bounded(options.maxPaths, 128, 1024), pathSteps: bounded(options.maxPathSteps, 64, 256) };
  const result: RepositoryImpact = { status: "draft", execution: "not-run", paths: [], boundaries: [], visitedStates: 0, limits, omittedPaths: 0 };
  const blocks = new Map(index.blocks.map((block) => [block.file, block]));
  const resolve = createRepositoryModuleResolver(index.blocks, index.coverage.skipped);
  const incoming = new Map<string, Array<{ block: RepositoryIndexBlock; local: string; imported: string; line: number; reexport: boolean; compiler?: string }>>();
  const unresolved = new Map<string, Array<{ line: number; module: string; reason: string; target?: string }>>();
  const blockedIncoming = new Map<string, Array<{ file: string; line: number; symbol: string; module: string; target?: string; reason: string }>>();
  for (const block of index.blocks) for (const binding of [...block.imports.map((entry) => ({ ...entry, reexport: false })),
    ...block.exports.filter((entry) => entry.module).map((entry) => ({ module: entry.module!, imported: entry.local, local: entry.exported, line: entry.line, reexport: true }))]) {
    const resolution = resolve(block.file, binding.module);
    if (resolution.reason || resolution.candidates.length !== 1) {
      const gaps = unresolved.get(block.file) ?? [];
      gaps.push({ line: binding.line, module: binding.module, reason: resolution.reason ?? "unresolved-module" });
      for (const excluded of resolution.excluded ?? []) gaps.push({ line: binding.line, module: binding.module,
        target: excluded.path, reason: `index-excluded-${excluded.reason}` });
      unresolved.set(block.file, gaps);
      for (const candidate of resolution.candidates) {
        const consumers = blockedIncoming.get(candidate) ?? [];
        consumers.push({ file: block.file, line: binding.line, symbol: binding.imported, module: binding.module, reason: resolution.reason ?? "unresolved-module" });
        for (const excluded of resolution.excluded ?? []) consumers.push({ file: block.file, line: binding.line,
          symbol: binding.imported, module: binding.module, target: excluded.path, reason: `index-excluded-${excluded.reason}` });
        blockedIncoming.set(candidate, consumers);
      }
      continue;
    }
    const target = resolution.candidates[0];
    if (resolution.compiler) {
      const gaps = unresolved.get(block.file) ?? [];
      gaps.push({ line: binding.line, module: binding.module, target, reason: "compiled-output-not-verified" });
      unresolved.set(block.file, gaps);
    }
    const consumers = incoming.get(target) ?? [];
    consumers.push({ block, local: binding.local, imported: binding.imported, line: binding.line, reexport: binding.reexport,
      ...(resolution.compiler ? { compiler: resolution.compiler } : {}) });
    incoming.set(target, consumers);
  }
  type State = { file: string; symbol: string; exported: boolean; member?: string; origin: { file: string; symbol: string }; evidence: ImpactStep[] };
  const queue: State[] = [];
  const seen = new Set<string>();
  const boundaryKeys = new Set<string>();
  const boundary = (entry: RepositoryImpact["boundaries"][number]): void => {
    const key = JSON.stringify(entry);
    if (!boundaryKeys.has(key)) { result.boundaries.push(entry); boundaryKeys.add(key); }
  };
  const enqueue = (state: State): void => {
    const key = JSON.stringify([state.origin.file, state.origin.symbol, state.file, state.symbol, state.exported, state.member]);
    if (seen.has(key)) return;
    if (state.evidence.length > limits.pathSteps) { boundary({ file: state.file, symbol: state.symbol, reason: "path-step-limit" }); return; }
    if (queue.length >= limits.states) { boundary({ file: state.file, symbol: state.symbol, reason: "state-limit" }); return; }
    seen.add(key); queue.push(state);
  };
  for (const change of [...changes].sort((a, b) => Number(blocks.get(a.file)?.kind === "test") - Number(blocks.get(b.file)?.kind === "test") || comparePaths(a.file, b.file))) {
    const block = blocks.get(change.file);
    if (!block) { boundary({ file: change.file, reason: "changed-file-not-indexed" }); continue; }
    const changedLines = change.lines?.filter(line => Number.isSafeInteger(line) && line > 0).sort((a, b) => a - b);
    const declarations = block.declarations.filter((entry) => !changedLines || changedLines.some((line) => line >= entry.line && line <= entry.endLine));
    if (!declarations.length) boundary({ file: change.file, reason: "changed-symbol-not-resolved" });
    for (const declaration of declarations) {
      const changedLine = changedLines?.find(line => line >= declaration.line && line <= declaration.endLine);
      enqueue({ file: change.file, symbol: declaration.name, exported: false,
        origin: { file: change.file, symbol: declaration.name },
        evidence: [{ file: change.file, line: declaration.line, symbol: declaration.name, relation: "changed-declaration",
          ...(changedLine !== undefined ? { changedLine } : {}) }] });
    }
  }
  const pathKeys = new Set<string>();
  const exportOrigins = (file: string, symbol: string, visited = new Set<string>(), depth = 0): { origins: Set<string>; unresolved: boolean } => {
    const key = `${file}:${symbol}`;
    if (visited.has(key)) return { origins: new Set(), unresolved: false };
    if (depth >= limits.pathSteps) {
      boundary({ file, symbol, reason: "export-origin-depth-limit" });
      return { origins: new Set(), unresolved: true };
    }
    if (visited.size >= limits.states) return { origins: new Set(), unresolved: true };
    visited.add(key);
    const block = blocks.get(file);
    if (!block || block.gaps.some((gap) => gap.kind === "parse-error")) return { origins: new Set(), unresolved: true };
    const explicit = block.exports.filter((entry) => entry.exported === symbol);
    const candidates = explicit.length ? explicit : symbol === "default" ? [] : block.exports.filter((entry) => entry.exported === "*");
    const origins = new Set<string>();
    let unknown = false;
    for (const entry of candidates) {
      if (!entry.module) { origins.add(`${file}:${entry.local}`); continue; }
      const target = resolve(file, entry.module);
      if (target.reason || target.candidates.length !== 1) { unknown = true; continue; }
      const nested = exportOrigins(target.candidates[0], entry.local === "*" ? symbol : entry.local, visited, depth + 1);
      for (const origin of nested.origins) origins.add(origin);
      unknown ||= nested.unresolved;
    }
    return { origins, unresolved: unknown };
  };
  const pathRank = (entry: RepositoryImpact["paths"][number]): number =>
    (blocks.get(entry.changedFile)?.kind === "source" ? 4 : 0)
    + (entry.changedFile !== entry.evidence.at(-1)?.file ? 2 : 0)
    + (entry.endpoint === "test-reference" ? 1 : 0);
  const endpoint = (state: State, step: ImpactStep, kind: "test-reference" | "registration-candidate"): void => {
    const key = JSON.stringify([state.origin, step.file, step.line, step.symbol, kind]);
    if (pathKeys.has(key)) return;
    pathKeys.add(key);
    const candidate = { changedFile: state.origin.file, changedSymbol: state.origin.symbol, endpoint: kind, evidence: [...state.evidence, step] };
    if (result.paths.length >= limits.paths) {
      result.omittedPaths++;
      const lowest = result.paths.reduce((chosen, entry, index) => pathRank(entry) < pathRank(result.paths[chosen]) ? index : chosen, 0);
      const omitted = pathRank(candidate) > pathRank(result.paths[lowest]) ? result.paths.splice(lowest, 1, candidate)[0] : candidate;
      const last = omitted.evidence.at(-1)!;
      boundary({ file: last.file, line: last.line, reason: "path-count-limit" });
      return;
    }
    result.paths.push(candidate);
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const state = queue[cursor];
    const block = blocks.get(state.file)!;
    result.visitedStates++;
    for (const gap of [...block.gaps.map((gap) => ({ line: gap.line, reason: gap.kind })), ...(unresolved.get(block.file) ?? [])]) {
      boundary({ file: block.file, symbol: state.symbol, ...gap });
    }
    if (block.gaps.some((gap) => gap.kind === "parse-error")) { boundary({ file: block.file, symbol: state.symbol, reason: "invalid-syntax-stops-trace" }); continue; }
    if (state.exported) {
      for (const gap of blockedIncoming.get(state.file) ?? []) {
        if (gap.symbol === state.symbol || gap.symbol === "*") boundary(gap);
      }
      for (const consumer of incoming.get(state.file) ?? []) {
        if (consumer.imported !== state.symbol && consumer.imported !== "*") continue;
        if (consumer.local === "<module>") { boundary({ file: consumer.block.file, line: consumer.line, reason: "side-effect-import" }); continue; }
        if (consumer.reexport && consumer.local === "*") {
          if (state.symbol === "default" || consumer.block.exports.some((entry) => entry.exported === state.symbol)) continue;
          const origins = exportOrigins(consumer.block.file, state.symbol);
          if (origins.unresolved || origins.origins.size !== 1) {
            boundary({ file: consumer.block.file, line: consumer.line, symbol: state.symbol, reason: "ambiguous-star-export" }); continue;
          }
        }
        const nextSymbol = consumer.reexport && consumer.local === "*" ? state.symbol : consumer.local;
        enqueue({ file: consumer.block.file, symbol: nextSymbol, exported: consumer.reexport,
          ...(!consumer.reexport && consumer.imported === "*" ? { member: state.symbol } : {}), origin: state.origin,
          evidence: [...state.evidence,
            ...(consumer.compiler ? [{ file: consumer.compiler, line: 1, symbol: state.symbol, relation: "compiler-mapping" as const }] : []),
            { file: consumer.block.file, line: consumer.line, symbol: nextSymbol, relation: consumer.reexport ? "reexport" : "import" }] });
      }
      continue;
    }
    for (const reference of block.references.filter((entry) => entry.name === state.symbol)) {
      if (state.member && reference.member !== state.member) {
        if (!reference.member) boundary({ file: block.file, line: reference.line, symbol: state.symbol, reason: "namespace-use-not-resolved" });
        continue;
      }
      if (block.kind === "test") endpoint(state, { file: block.file, line: reference.line, symbol: state.symbol, relation: "test-reference" }, "test-reference");
      if (reference.registration === true) {
        endpoint(state, { file: block.file, line: reference.line, symbol: state.symbol, relation: "registration-candidate" }, "registration-candidate");
      }
      if (reference.owner !== "<module>" && reference.owner !== state.symbol) enqueue({ file: block.file, symbol: reference.owner, exported: false, origin: state.origin,
        evidence: [...state.evidence, { file: block.file, line: reference.line, symbol: reference.owner, relation: "reference" }] });
    }
    if (!state.member) for (const exported of block.exports.filter((entry) => !entry.module && entry.local === state.symbol)) {
      enqueue({ ...state, symbol: exported.exported, exported: true,
        evidence: [...state.evidence, { file: block.file, line: exported.line, symbol: exported.exported, relation: "export" }] });
    }
  }
  for (const change of changes) if (!result.paths.some((entry) => entry.changedFile === change.file)) {
    boundary({ file: change.file, reason: "no-observable-contract-path" });
  }
  result.paths.sort((a, b) => pathRank(b) - pathRank(a));
  result.boundaries.sort((a, b) => comparePaths(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || comparePaths(a.reason, b.reason)
    || comparePaths(a.symbol ?? "", b.symbol ?? "") || comparePaths(a.module ?? "", b.module ?? "") || comparePaths(a.target ?? "", b.target ?? ""));
  return result;
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(maximum, Math.trunc(value)));
}
