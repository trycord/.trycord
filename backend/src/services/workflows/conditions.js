// Conditions and placeholders.
//
// A workflow's conditions are compared field by field and its parameters may
// contain placeholders. Neither is an expression language: a condition is a
// path, an operator from a fixed list, and a value; a placeholder is a path
// in braces. Nothing here evaluates text as code, so a workflow cannot reach
// anything the catalogue does not name.
//
// The values a condition sees are the ones the run carries: the event
// payload, the run's own facts, and the output of the steps that have already
// run.

const MAX_DEPTH = 8;

// Read a dotted path out of an object. `steps.0.output.count` reaches into
// the output of the first step.
function readPath(values, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return undefined;
  let current = values;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function compare(actual, expected) {
  if (actual === undefined || actual === null) return false;
  if (typeof actual === 'boolean' || typeof expected === 'boolean') return Boolean(actual) === Boolean(expected);
  if (typeof actual === 'number' || typeof expected === 'number') {
    const a = Number(actual);
    const b = Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return a === b;
  }
  return String(actual) === String(expected);
}

/**
 * Evaluate a condition list.
 *
 * Every condition has to hold. The result names the first one that did not,
 * so the run history says why nothing happened rather than only that nothing
 * happened.
 */
function evaluate(conditions, values) {
  for (const condition of conditions || []) {
    const actual = readPath(values, condition.field);
    let ok = false;
    switch (condition.op) {
      case 'eq':
        ok = compare(actual, condition.value);
        break;
      case 'neq':
        ok = !compare(actual, condition.value);
        break;
      case 'gt':
        ok = Number(actual) > Number(condition.value);
        break;
      case 'gte':
        ok = Number(actual) >= Number(condition.value);
        break;
      case 'lt':
        ok = Number(actual) < Number(condition.value);
        break;
      case 'lte':
        ok = Number(actual) <= Number(condition.value);
        break;
      case 'contains':
        ok = actual !== undefined && actual !== null && String(actual).includes(String(condition.value));
        break;
      case 'notContains':
        ok = actual === undefined || actual === null || !String(actual).includes(String(condition.value));
        break;
      case 'in':
        ok = Array.isArray(condition.value)
          && condition.value.some((v) => compare(actual, v));
        break;
      case 'exists':
        ok = condition.value === false ? actual === undefined : actual !== undefined;
        break;
      default:
        ok = false;
    }
    if (!ok) {
      return { ok: false, failed: condition, reason: 'the condition on "' + condition.field + '" did not hold' };
    }
  }
  return { ok: true, failed: null, reason: null };
}

/**
 * Substitute the placeholders in a template.
 *
 * `{{serverId}}` becomes the value of that path in the run's values. A
 * placeholder that names a path that is not there is left as written, so a
 * message that happens to contain braces is not silently emptied.
 */
function resolve(template, values) {
  if (typeof template !== 'string') return template;
  if (template.indexOf('{{') === -1) return template;
  return template.replace(/\{\{([^{}]+)\}\}/g, (whole, path) => {
    const value = readPath(values, path.trim());
    if (value === undefined || value === null) return whole;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Resolve the placeholders in a parameter object.
 *
 * Strings are substituted; everything else is left alone, because a
 * parameter that is a number or a boolean is a number or a boolean.
 */
function resolveParams(params, values) {
  if (!params || typeof params !== 'object') return params;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') out[key] = resolve(value, values);
    else if (Array.isArray(value)) out[key] = value.map((v) => (typeof v === 'string' ? resolve(v, values) : v));
    else out[key] = value;
  }
  return out;
}

module.exports = { readPath, evaluate, resolve, resolveParams, MAX_DEPTH };
