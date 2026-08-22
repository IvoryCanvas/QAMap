// Task suite loading and validation. The suite is committed under
// test/agent-tasks; each task is validated against schema.json with a small
// built-in validator so the harness keeps its zero-dependency contract.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LOCAL_CRITERIA_KINDS } from "./judge.mjs";

export const SUITE_DIRECTORY = "test/agent-tasks";

export async function loadSuite({ repositoryRoot, taskIds, suiteDirectory = SUITE_DIRECTORY }) {
  const root = path.resolve(repositoryRoot);
  const suiteRoot = resolveInside(root, suiteDirectory);
  const schema = JSON.parse(await fs.readFile(path.join(suiteRoot, "schema.json"), "utf8"));
  const tasks = [];
  const hash = createHash("sha256");

  for (const id of taskIds) {
    const taskDir = resolveInside(suiteRoot, id);
    const taskPath = path.join(taskDir, "task.json");
    const text = await fs.readFile(taskPath, "utf8");
    const raw = JSON.parse(text);
    const errors = validateSchema(raw, schema);
    if (errors.length > 0) {
      throw new Error(`Task ${id} is invalid:\n- ${errors.join("\n- ")}`);
    }
    if (raw.id !== id) {
      throw new Error(`Task directory ${id} declares id ${raw.id}.`);
    }
    for (const criterion of raw.successCriteria) {
      if (!LOCAL_CRITERIA_KINDS.includes(criterion.kind)) {
        throw new Error(`Task ${id} uses unsupported success criterion ${criterion.kind}.`);
      }
    }
    const fixtureRoot = resolveInside(root, raw.fixture.path);
    for (const overlay of ["base", raw.fixture.baseOverlay, raw.fixture.headOverlay]) {
      await requireDirectory(resolveInside(fixtureRoot, overlay), `Task ${id} fixture overlay ${overlay}`);
    }
    for (const input of raw.inputs ?? []) {
      await requireFile(resolveInside(taskDir, input.from), `Task ${id} input ${input.from}`);
    }
    hash.update(id);
    hash.update("\0");
    hash.update(text);
    hash.update("\0");
    tasks.push({ ...raw, dir: taskDir, fixtureRoot });
  }

  return { tasks, schema, sha256: hash.digest("hex") };
}

export function validateSchema(value, schema, rootSchema = schema, pointer = "$") {
  const errors = [];
  if (schema.$ref) {
    return validateSchema(value, resolveRef(rootSchema, schema.$ref), rootSchema, pointer);
  }
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter(
      (alternative) => validateSchema(value, alternative, rootSchema, pointer).length === 0,
    );
    if (matching.length !== 1) {
      errors.push(`${pointer} must match exactly one allowed shape (matched ${matching.length})`);
    }
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${pointer} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${pointer} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${pointer} must be of type ${types.join(" or ")}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer} must have at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pointer} must match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pointer} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${pointer} must be at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer} must have at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${pointer} must have at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(item, schema.items, rootSchema, `${pointer}[${index}]`));
      });
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${pointer}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        errors.push(...validateSchema(child, properties[key], rootSchema, `${pointer}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer}.${key} is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateSchema(child, schema.additionalProperties, rootSchema, `${pointer}.${key}`));
      }
    }
  }
  return errors;
}

function matchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref ${ref}.`);
  let current = rootSchema;
  for (const segment of ref.slice(2).split("/")) {
    current = current?.[segment];
    if (current === undefined) throw new Error(`Unresolved $ref ${ref}.`);
  }
  return current;
}

async function requireDirectory(directory, label) {
  const stats = await fs.stat(directory).catch(() => null);
  if (!stats || !stats.isDirectory()) throw new Error(`${label} is not a directory.`);
}

async function requireFile(file, label) {
  const stats = await fs.stat(file).catch(() => null);
  if (!stats || !stats.isFile()) throw new Error(`${label} is not a file.`);
}

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes its allowed root: ${relativePath}`);
  }
  return resolved;
}
