export function collectSchemaViolations(schema, value, location = "$", rootSchema = schema) {
  if (schema.$ref) {
    const resolved = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((current, part) => current?.[part], rootSchema);
    return resolved
      ? collectSchemaViolations(resolved, value, location, rootSchema)
      : [`${location}: unresolved schema reference ${schema.$ref}`];
  }
  const violations = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const matches = types.some((type) =>
      type === actual ||
      (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (type === "number" && typeof value === "number")
    );
    if (!matches) {
      violations.push(`${location}: expected ${types.join("|")}, got ${actual}`);
      return violations;
    }
  }
  if ("const" in schema && value !== schema.const) {
    violations.push(`${location}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    violations.push(`${location}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    violations.push(`${location}: ${value} below minimum ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) {
    violations.push(`${location}: ${value} above maximum ${schema.maximum}`);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        violations.push(`${location}: missing required ${key}`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value && value[key] !== undefined) {
        violations.push(...collectSchemaViolations(child, value[key], `${location}.${key}`, rootSchema));
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      violations.push(...collectSchemaViolations(schema.items, item, `${location}[${index}]`, rootSchema));
    }
  }
  return violations;
}
