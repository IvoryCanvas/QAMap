import path from "node:path";
import YAML from "yaml";

export type ApiContractAuthorityStatus = "example" | "contract-only" | "missing";

export interface ApiContractResponseExample {
  file: string;
  endpoint: string;
  method: string;
  status: number;
  mediaType?: string;
  body: unknown;
}

export interface ApiContractOperationEvidence {
  file: string;
  endpoint: string;
  method: string;
  statuses: number[];
  examples: ApiContractResponseExample[];
}

export interface ApiContractAuthority {
  status: ApiContractAuthorityStatus;
  reason: string;
  sources: string[];
  examples: ApiContractResponseExample[];
}

interface ContractSourceFile {
  path: string;
  text?: string;
}

const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const maxExampleBytes = 20_000;
const maxAuthorityExamples = 8;

export function collectApiContractOperations(files: ContractSourceFile[]): ApiContractOperationEvidence[] {
  return files.flatMap((file) => {
    if (!file.text || !isOpenApiSourcePath(file.path)) {
      return [];
    }
    return analyzeOpenApiSource(file.path, file.text);
  });
}

export function summarizeApiContractAuthority(
  operations: ApiContractOperationEvidence[],
  endpoints: string[],
): ApiContractAuthority {
  const matching = operations.filter((operation) =>
    endpoints.some((endpoint) => contractPathsMatch(operation.endpoint, endpoint)),
  );
  if (matching.length === 0) {
    return {
      status: "missing",
      reason: "No matching OpenAPI or Swagger operation was found for the detected endpoint.",
      sources: [],
      examples: [],
    };
  }

  const examples: ApiContractResponseExample[] = [];
  for (const endpoint of endpoints) {
    const endpointOperations = matching.filter((operation) => contractPathsMatch(operation.endpoint, endpoint));
    const methods = new Set(endpointOperations.map((operation) => operation.method));
    if (methods.size !== 1) {
      continue;
    }
    for (const operation of endpointOperations) {
      examples.push(...operation.examples);
    }
  }

  const sources = unique(matching.map((operation) => operation.file));
  if (examples.length > 0) {
    return {
      status: "example",
      reason: "A matching machine-readable API contract includes an exact response example.",
      sources,
      examples: uniqueExamples(examples).slice(0, maxAuthorityExamples),
    };
  }
  return {
    status: "contract-only",
    reason: "A matching machine-readable API contract defines the operation, but no safe, unambiguous response example is available.",
    sources,
    examples: [],
  };
}

function analyzeOpenApiSource(file: string, text: string): ApiContractOperationEvidence[] {
  let document: unknown;
  try {
    document = YAML.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(document) || (!("openapi" in document) && !("swagger" in document)) || !isRecord(document.paths)) {
    return [];
  }

  const operations: ApiContractOperationEvidence[] = [];
  for (const [endpoint, pathItem] of Object.entries(document.paths)) {
    if (!endpoint.startsWith("/") || !isRecord(pathItem)) {
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      const normalizedMethod = method.toLowerCase();
      if (!httpMethods.has(normalizedMethod) || !isRecord(operation) || !isRecord(operation.responses)) {
        continue;
      }
      const statuses: number[] = [];
      const examples: ApiContractResponseExample[] = [];
      for (const [statusKey, response] of Object.entries(operation.responses)) {
        const status = parseStatus(statusKey);
        if (status === undefined || !isRecord(response)) {
          continue;
        }
        statuses.push(status);
        for (const candidate of responseExamples(response)) {
          examples.push({
            file,
            endpoint,
            method: normalizedMethod.toUpperCase(),
            status,
            ...(candidate.mediaType ? { mediaType: candidate.mediaType } : {}),
            body: candidate.body,
          });
        }
      }
      operations.push({
        file,
        endpoint,
        method: normalizedMethod.toUpperCase(),
        statuses: uniqueNumbers(statuses),
        examples,
      });
    }
  }
  return operations;
}

function responseExamples(response: Record<string, unknown>): Array<{ mediaType?: string; body: unknown }> {
  const examples: Array<{ mediaType?: string; body: unknown }> = [];
  if (isRecord(response.content)) {
    for (const [mediaType, media] of Object.entries(response.content)) {
      if (!isRecord(media)) {
        continue;
      }
      pushExample(examples, media.example, mediaType);
      if (isRecord(media.examples)) {
        for (const example of Object.values(media.examples)) {
          pushExample(examples, isRecord(example) && "value" in example ? example.value : example, mediaType);
        }
      }
      if (isRecord(media.schema)) {
        pushExample(examples, media.schema.example, mediaType);
      }
    }
  }
  if (isRecord(response.examples)) {
    for (const [mediaType, body] of Object.entries(response.examples)) {
      pushExample(examples, body, mediaType);
    }
  }
  pushExample(examples, response.example);
  return examples;
}

function pushExample(
  examples: Array<{ mediaType?: string; body: unknown }>,
  value: unknown,
  mediaType?: string,
): void {
  if (mediaType && !/json/i.test(mediaType)) {
    return;
  }
  const body = jsonSafeExample(value);
  if (body === undefined) {
    return;
  }
  examples.push({ ...(mediaType ? { mediaType } : {}), body });
}

function jsonSafeExample(value: unknown): unknown | undefined {
  if (value === undefined || isRecord(value) && "$ref" in value) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxExampleBytes) {
      return undefined;
    }
    const parsed = JSON.parse(serialized) as unknown;
    return containsSensitiveExampleField(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function containsSensitiveExampleField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveExampleField);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nested]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return /^(?:access|refresh|id|session)?token$/.test(normalizedKey) ||
      /^(?:api|client)?secret$/.test(normalizedKey) ||
      /^(?:api|private)key$/.test(normalizedKey) ||
      /^(?:password|passwd|authorization|cookie|setcookie)$/.test(normalizedKey) ||
      containsSensitiveExampleField(nested);
  });
}

export function isOpenApiSourcePath(file: string): boolean {
  const basename = path.basename(file);
  return /(?:openapi|swagger)/i.test(basename) && /\.(?:json|ya?ml)$/i.test(basename);
}

function contractPathsMatch(left: string, right: string): boolean {
  const leftSegments = contractPathSegments(left);
  const rightSegments = contractPathSegments(right);
  if (leftSegments.length === 0 || leftSegments.length !== rightSegments.length) {
    return false;
  }
  return leftSegments.every((segment, index) =>
    segment === "*" || rightSegments[index] === "*" || segment === rightSegments[index],
  );
}

function contractPathSegments(value: string): string[] {
  let route = value.trim().replace(/\$\{[^}]+\}/g, "*");
  route = route.replace(/^https?:\/\/[^/]*/i, "").split(/[?#]/)[0];
  const firstSlash = route.indexOf("/");
  if (firstSlash < 0) {
    return [];
  }
  return route
    .slice(firstSlash)
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment === "*" || segment.includes("*") || segment.startsWith(":") || /^\{.+\}$/.test(segment) || /^\[.+\]$/.test(segment)
        ? "*"
        : segment.toLowerCase(),
    );
}

function parseStatus(value: string): number | undefined {
  if (!/^\d{3}$/.test(value)) {
    return undefined;
  }
  const status = Number(value);
  return status >= 100 && status < 600 ? status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueExamples(values: ApiContractResponseExample[]): ApiContractResponseExample[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.file}\0${value.endpoint}\0${value.method}\0${value.status}\0${JSON.stringify(value.body)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
