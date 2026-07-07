// Static analysis of discovered mock/fixture/seed files. The project scan
// already loads their text; this module turns that text into concrete,
// nameable evidence (exports, handled routes, response-shape keys) so fixture
// guidance can say "extend this file for that endpoint" instead of "add a
// deterministic mock somewhere".

export interface FixtureFileInsight {
  file: string;
  exports: string[];
  handledEndpoints: string[];
  sampleKeys: string[];
}

const maxExports = 6;
const maxHandledEndpoints = 8;
const maxSampleKeys = 6;
const maxScanChars = 200_000;

const jsExportMatcher = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
const commonJsExportMatcher = /\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=/g;
const pythonDefinitionMatcher = /^(?:def|class)\s+([A-Za-z_][\w]*)/gm;
// MSW v1 (rest.get) and MSW v2 (http.get) handlers. graphql.query/mutation
// handlers are skipped: operation names are not URL routes.
const mswHandlerMatcher = /\b(?:rest|http)\.(?:get|post|put|patch|delete|head|options|all)\s*\(\s*["'`]([^"'`\n]+)["'`]/g;
// Mirage server routes and express-style mock servers.
const serverRouteMatcher = /\b(?:this|app|router|server)\.(?:get|post|put|patch|del|delete|all)\s*\(\s*["'`](\/[^"'`\n]*)["'`]/g;
// Playwright route interception patterns registered inside fixture helpers.
const playwrightRouteMatcher = /\broute\s*\(\s*["'`]([^"'`\n]+)["'`]/g;
// Keys only count as response-shape evidence when their value starts like a
// data literal; `mutationFn: fn` style code options and TS type annotations
// are noise, `total: 0` and `items: []` are signal.
const objectKeyMatcher = /[{,]\s*["']?([A-Za-z_$][\w$]{1,40})["']?\s*:\s*(?=["'`[{\d-]|true\b|false\b|null\b)/g;
const yamlTopLevelKeyMatcher = /^([A-Za-z_][\w-]{1,40}):/gm;

export function analyzeFixtureSource(file: string, text: string): FixtureFileInsight {
  const scanText = text.slice(0, maxScanChars);
  if (/\.json$/i.test(file)) {
    return {
      file,
      exports: [],
      handledEndpoints: [],
      sampleKeys: jsonSampleKeys(scanText),
    };
  }
  if (/\.ya?ml$/i.test(file)) {
    return {
      file,
      exports: [],
      handledEndpoints: [],
      sampleKeys: matchAllCaptures(scanText, yamlTopLevelKeyMatcher).slice(0, maxSampleKeys),
    };
  }

  const exports = /\.py$/i.test(file)
    ? matchAllCaptures(scanText, pythonDefinitionMatcher)
    : uniqueInOrder([
        ...matchAllCaptures(scanText, jsExportMatcher),
        ...matchAllCaptures(scanText, commonJsExportMatcher),
      ]);
  const handledEndpoints = uniqueInOrder(
    [
      ...matchAllCaptures(scanText, mswHandlerMatcher),
      ...matchAllCaptures(scanText, serverRouteMatcher),
      ...matchAllCaptures(scanText, playwrightRouteMatcher),
    ]
      .map(normalizeRoutePattern)
      .filter((route): route is string => route !== undefined),
  );
  return {
    file,
    exports: exports.slice(0, maxExports),
    handledEndpoints: handledEndpoints.slice(0, maxHandledEndpoints),
    sampleKeys: codeSampleKeys(scanText),
  };
}

// True when a handler pattern in the fixture file already serves the endpoint.
// Dynamic single segments (:id, [id], ${...}, globs) normalize to "*" and
// match exactly one segment on either side; only a trailing "**" acts as a
// rest glob that matches any remaining segments (including none). A pattern
// like /api/orders/:id therefore covers /api/orders/123 but not /api/orders
// or /api/orders/123/items.
export function insightCoversEndpoint(insight: FixtureFileInsight, endpoint: string): boolean {
  const target = routeSegments(endpoint);
  if (target.length === 0) {
    return false;
  }
  return insight.handledEndpoints.some((handled) => {
    const pattern = routeSegments(handled);
    if (pattern.length === 0) {
      return false;
    }
    const restGlob = pattern[pattern.length - 1] === "**";
    if (!restGlob && pattern.length !== target.length) {
      return false;
    }
    if (restGlob && pattern.length - 1 > target.length) {
      return false;
    }
    const compareLength = restGlob ? pattern.length - 1 : pattern.length;
    for (let index = 0; index < compareLength; index += 1) {
      if (!segmentsMatch(pattern[index], target[index])) {
        return false;
      }
    }
    return true;
  });
}

function segmentsMatch(patternSegment: string, targetSegment: string): boolean {
  const isWildcard = (segment: string): boolean => segment === "*" || segment === "**";
  return isWildcard(patternSegment) || isWildcard(targetSegment) || patternSegment === targetSegment;
}

function normalizeRoutePattern(value: string): string | undefined {
  let route = value.trim();
  if (route.length === 0 || route.length > 180 || /\s/.test(route)) {
    return undefined;
  }
  route = route.replace(/\$\{[^}]*\}/g, "*");
  // Strip host-bearing prefixes: schemes (https://host, *://host) and
  // protocol-relative //host, so hosts never masquerade as path segments.
  route = route.replace(/^(?:[a-z][a-z0-9+.-]*|\*):\/\/[^/]*/i, "");
  route = route.replace(/^\/\/[^/]*/, "");
  // A handler registered on "*" or "**" alone intercepts every route.
  if (/^\*+$/.test(route)) {
    return "/**";
  }
  const firstSlash = route.indexOf("/");
  if (firstSlash === -1) {
    return undefined;
  }
  // Only glob prefixes (e.g. "**" in "**/api/orders") may precede the path;
  // a relative pattern like "api/orders" is ambiguous, so it is dropped
  // rather than silently truncated.
  const prefix = route.slice(0, firstSlash);
  if (prefix.length > 0 && !/^\*+$/.test(prefix)) {
    return undefined;
  }
  route = route.slice(firstSlash);
  route = route.split(/[?#]/)[0];
  return route === "/" ? undefined : route;
}

function routeSegments(value: string): string[] {
  const normalized = normalizeRoutePattern(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === "**") {
        return "**";
      }
      if (segment.includes("*") || segment.startsWith(":") || /^\[.*\]$/.test(segment)) {
        return "*";
      }
      return segment.toLowerCase();
    });
}

function jsonSampleKeys(text: string): string[] {
  try {
    let parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      parsed = parsed[0];
    }
    if (parsed && typeof parsed === "object") {
      return Object.keys(parsed as Record<string, unknown>).slice(0, maxSampleKeys);
    }
  } catch {
    // Malformed JSON fixtures still count as path-level evidence.
  }
  return [];
}

function codeSampleKeys(text: string): string[] {
  const keys: string[] = [];
  for (const key of matchAllCaptures(text, objectKeyMatcher)) {
    if (!keys.includes(key)) {
      keys.push(key);
    }
    if (keys.length >= maxSampleKeys) {
      break;
    }
  }
  return keys;
}

function matchAllCaptures(text: string, matcher: RegExp): string[] {
  const results: string[] = [];
  for (const match of text.matchAll(matcher)) {
    if (match[1]) {
      results.push(match[1]);
    }
  }
  return results;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      results.push(value);
    }
  }
  return results;
}
