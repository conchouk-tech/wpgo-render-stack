const SINGLE_SCHEMA_KEYS = new Set([
  'additionalProperties', 'contains', 'contentSchema', 'else', 'if', 'items',
  'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties'
]);

const SCHEMA_MAP_KEYS = new Set([
  '$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'
]);

const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function isSchemaNode(value) {
  return value === true || value === false || (value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * WordPress/PHP encodes an empty associative array and an empty list as the same
 * JSON value (`[]`). Some WPGo ability definitions historically used array()
 * for an unconstrained schema. MCP clients correctly reject [] in a schema
 * position. Repair only values that are known to be JSON-Schema positions.
 */
export function repairJsonSchema(input) {
  if (input === true || input === false) return input;
  if (Array.isArray(input)) return {};
  if (!input || typeof input !== 'object') return {};

  const schema = clone(input);

  for (const key of SCHEMA_MAP_KEYS) {
    const map = schema[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [name, child] of Object.entries(map)) {
      map[name] = repairJsonSchema(child);
    }
  }

  for (const key of SINGLE_SCHEMA_KEYS) {
    if (!(key in schema)) continue;
    const child = schema[key];
    // items may legitimately be absent but when present it must be a schema.
    schema[key] = repairJsonSchema(child);
  }

  for (const key of SCHEMA_ARRAY_KEYS) {
    if (!Array.isArray(schema[key])) continue;
    schema[key] = schema[key].map(repairJsonSchema);
  }

  if (schema.dependencies && typeof schema.dependencies === 'object' && !Array.isArray(schema.dependencies)) {
    for (const [name, child] of Object.entries(schema.dependencies)) {
      if (Array.isArray(child) && child.every(item => typeof item === 'string')) continue;
      schema.dependencies[name] = repairJsonSchema(child);
    }
  }

  return schema;
}

function validateNode(schema, path, errors) {
  if (!isSchemaNode(schema)) {
    errors.push(`${path}: schema must be an object or boolean`);
    return;
  }
  if (typeof schema === 'boolean') return;

  for (const key of SCHEMA_MAP_KEYS) {
    if (!(key in schema)) continue;
    const map = schema[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      errors.push(`${path}.${key}: expected an object of schemas`);
      continue;
    }
    for (const [name, child] of Object.entries(map)) {
      validateNode(child, `${path}.${key}.${name}`, errors);
    }
  }

  for (const key of SINGLE_SCHEMA_KEYS) {
    if (!(key in schema)) continue;
    validateNode(schema[key], `${path}.${key}`, errors);
  }

  for (const key of SCHEMA_ARRAY_KEYS) {
    if (!(key in schema)) continue;
    if (!Array.isArray(schema[key])) {
      errors.push(`${path}.${key}: expected an array of schemas`);
      continue;
    }
    schema[key].forEach((child, index) => validateNode(child, `${path}.${key}[${index}]`, errors));
  }

  if (schema.dependencies && typeof schema.dependencies === 'object' && !Array.isArray(schema.dependencies)) {
    for (const [name, child] of Object.entries(schema.dependencies)) {
      if (Array.isArray(child) && child.every(item => typeof item === 'string')) continue;
      validateNode(child, `${path}.dependencies.${name}`, errors);
    }
  }
}

export function validateJsonSchema(schema) {
  const errors = [];
  validateNode(schema, '$', errors);
  return { ok: errors.length === 0, errors };
}

export function repairAndValidateJsonSchema(schema) {
  const repaired = repairJsonSchema(schema);
  const validation = validateJsonSchema(repaired);
  if (!validation.ok) {
    const error = new Error(`Invalid MCP JSON Schema: ${validation.errors.join('; ')}`);
    error.validationErrors = validation.errors;
    throw error;
  }
  return repaired;
}
