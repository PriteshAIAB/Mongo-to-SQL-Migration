const { ObjectId } = require('mongodb');
const { Decimal128, Binary, Long, Int32 } = require('mongodb');
const { isDate } = require('./dateConvert');

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  if (value instanceof Date || value instanceof ObjectId) {
    return false;
  }
  if (
    value instanceof Decimal128 ||
    value instanceof Binary ||
    value instanceof Long ||
    value instanceof Int32
  ) {
    return false;
  }
  return true;
}

/**
 * Join path segments for flattened keys (e.g. address + city -> address_city).
 * @param {string} prefix
 * @param {string} key
 * @returns {string}
 */
function joinPath(prefix, key) {
  if (!prefix) {
    return key;
  }
  return `${prefix}_${key}`;
}

/**
 * JSON.stringify with BSON-ish leaves expanded so SQL stores readable JSON (not Extended JSON wrappers).
 * @param {unknown} value
 * @returns {string}
 */
function jsonStringifyMongoValue(value) {
  return JSON.stringify(value, (_, v) => {
    if (v instanceof ObjectId) {
      return v.toHexString();
    }
    if (v instanceof Date) {
      return v.toISOString();
    }
    if (v instanceof Decimal128) {
      return v.toString();
    }
    if (v instanceof Long || v instanceof Int32) {
      return Number(v);
    }
    if (v instanceof Binary) {
      return v.toString('base64');
    }
    return v;
  });
}

/**
 * @param {unknown} el
 * @returns {boolean}
 */
function isArrayElementFlatScalar(el) {
  if (el === null || el === undefined) {
    return true;
  }
  if (typeof el === 'string' || typeof el === 'number' || typeof el === 'boolean') {
    return true;
  }
  if (el instanceof ObjectId) {
    return true;
  }
  if (isDate(el)) {
    return true;
  }
  if (el instanceof Decimal128 || el instanceof Long || el instanceof Int32) {
    return true;
  }
  return false;
}

/**
 * Arrays of ObjectIds / primitives become comma-separated values (easier in T-SQL than a JSON text blob).
 * Nested objects or arrays stay as JSON (single column).
 * @param {unknown[]} arr
 * @returns {string|null}
 */
function serializeArrayForSql(arr) {
  if (!arr.length) {
    return null;
  }
  const allFlat = arr.every(isArrayElementFlatScalar);
  if (!allFlat) {
    return jsonStringifyMongoValue(arr);
  }
  return arr
    .map((el) => {
      if (el === null || el === undefined) {
        return '';
      }
      if (el instanceof ObjectId) {
        return el.toHexString();
      }
      if (isDate(el)) {
        return el.toISOString();
      }
      if (el instanceof Decimal128) {
        return el.toString();
      }
      if (el instanceof Long || el instanceof Int32) {
        return String(Number(el));
      }
      return String(el);
    })
    .join(',');
}

/**
 * Serialize leaf values for SQL-friendly storage.
 * @param {unknown} value
 * @returns {unknown}
 */
function serializeLeaf(value) {
  if (value === undefined) {
    return null;
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (value instanceof Date) {
    return value;
  }
  if (value instanceof Decimal128) {
    return value.toString();
  }
  if (value instanceof Long || value instanceof Int32) {
    return Number(value);
  }
  if (value instanceof Binary) {
    return value.toString('base64');
  }
  if (Array.isArray(value)) {
    return serializeArrayForSql(value);
  }
  if (isPlainObject(value)) {
    return jsonStringifyMongoValue(value);
  }
  return value;
}

/**
 * Flatten nested documents; arrays and complex leaves become JSON strings.
 * @param {Record<string, unknown>} obj
 * @param {string} [prefix='']
 * @param {Record<string, unknown>} [out={}]
 * @returns {Record<string, unknown>}
 */
function flattenDocument(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object') {
    return out;
  }

  for (const [key, raw] of Object.entries(obj)) {
    const path = joinPath(prefix, key);

    if (raw === undefined) {
      continue;
    }
    if (raw === null) {
      out[path] = null;
      continue;
    }
    if (raw instanceof ObjectId || isDate(raw) || typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string') {
      out[path] = serializeLeaf(raw);
      continue;
    }
    if (raw instanceof Decimal128 || raw instanceof Binary || raw instanceof Long || raw instanceof Int32) {
      out[path] = serializeLeaf(raw);
      continue;
    }
    if (Array.isArray(raw)) {
      out[path] = serializeArrayForSql(raw);
      continue;
    }
    if (isPlainObject(raw)) {
      flattenDocument(raw, path, out);
      continue;
    }
    out[path] = serializeLeaf(raw);
  }

  return out;
}

module.exports = {
  flattenDocument,
  isPlainObject,
  joinPath,
  serializeArrayForSql,
  jsonStringifyMongoValue,
};
