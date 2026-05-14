const sql = require('mssql');

/**
 * Map inferred logical types to mssql driver column definitions.
 * Per requirements:
 * string -> NVARCHAR(MAX)
 * number -> FLOAT
 * boolean -> BIT
 * date -> DATETIME2
 * ObjectId -> VARCHAR(24)
 * object -> NVARCHAR(MAX)
 * array -> NVARCHAR(MAX)
 */

const LOGICAL = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date',
  OBJECT_ID: 'objectId',
  OBJECT: 'object',
  ARRAY: 'array',
  NULL: 'null',
  BINARY: 'binary',
  UNKNOWN: 'unknown',
  DECIMAL128: 'decimal128',
};

/**
 * Merge two logical types into a single column type (widening).
 * @param {string|null} existing
 * @param {string} next
 * @returns {string}
 */
function mergeLogicalTypes(existing, next) {
  if (!existing || existing === LOGICAL.NULL) {
    return next === LOGICAL.NULL ? LOGICAL.STRING : next;
  }
  if (next === LOGICAL.NULL) {
    return existing;
  }
  if (existing === next) {
    return existing;
  }

  const rank = (t) => {
    switch (t) {
      case LOGICAL.BOOLEAN:
        return 1;
      case LOGICAL.NUMBER:
        return 2;
      case LOGICAL.DATE:
        return 3;
      case LOGICAL.OBJECT_ID:
        return 4;
      case LOGICAL.STRING:
      case LOGICAL.DECIMAL128:
        return 5;
      case LOGICAL.ARRAY:
      case LOGICAL.OBJECT:
      case LOGICAL.BINARY:
      case LOGICAL.UNKNOWN:
        return 6;
      default:
        return 6;
    }
  };

  // Mixed primitives widen to string (NVARCHAR) for safety
  const set = new Set([existing, next]);
  if (set.has(LOGICAL.STRING) && (set.has(LOGICAL.NUMBER) || set.has(LOGICAL.BOOLEAN) || set.has(LOGICAL.DATE))) {
    return LOGICAL.STRING;
  }
  if (set.has(LOGICAL.NUMBER) && set.has(LOGICAL.BOOLEAN)) {
    return LOGICAL.STRING;
  }
  if (set.has(LOGICAL.OBJECT_ID) && set.has(LOGICAL.STRING)) {
    return LOGICAL.STRING;
  }

  return rank(existing) >= rank(next) ? existing : next;
}

/**
 * @param {string} logical
 * @returns {{ sqlType: import('mssql').ISqlTypeFactoryWithNoParams | import('mssql').ISqlTypeFactoryWithLength | import('mssql').ISqlTypeFactoryWithPrecisionScale, declaration: string }}
 */
function logicalToSql(logical) {
  switch (logical) {
    case LOGICAL.BOOLEAN:
      return { sqlType: sql.Bit, declaration: 'BIT' };
    case LOGICAL.NUMBER:
      return { sqlType: sql.Float, declaration: 'FLOAT' };
    case LOGICAL.DATE:
      return { sqlType: sql.DateTime2, declaration: 'DATETIME2' };
    case LOGICAL.OBJECT_ID:
      return { sqlType: sql.VarChar(24), declaration: 'VARCHAR(24)' };
    case LOGICAL.ARRAY:
    case LOGICAL.OBJECT:
    case LOGICAL.BINARY:
    case LOGICAL.UNKNOWN:
    case LOGICAL.STRING:
    case LOGICAL.DECIMAL128:
    default:
      return { sqlType: sql.NVarChar(sql.MAX), declaration: 'NVARCHAR(MAX)' };
  }
}

/**
 * @param {string} detected
 * @returns {string}
 */
function detectedToLogical(detected) {
  switch (detected) {
    case 'null':
      return LOGICAL.NULL;
    case 'objectId':
      return LOGICAL.OBJECT_ID;
    case 'date':
      return LOGICAL.DATE;
    case 'boolean':
      return LOGICAL.BOOLEAN;
    case 'number':
      return LOGICAL.NUMBER;
    case 'string':
      return LOGICAL.STRING;
    case 'array':
      return LOGICAL.ARRAY;
    case 'object':
      return LOGICAL.OBJECT;
    case 'decimal128':
      return LOGICAL.DECIMAL128;
    case 'binary':
      return LOGICAL.BINARY;
    default:
      return LOGICAL.UNKNOWN;
  }
}

/**
 * Sanitize identifier for SQL Server bracketed name.
 * @param {string} name
 * @returns {string}
 */
function sanitizeColumnName(name) {
  let cleaned = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
  if (!cleaned) {
    return 'col';
  }
  if (/^[0-9]/.test(cleaned)) {
    cleaned = `c_${cleaned}`;
  }
  if (cleaned.length > 128) {
    cleaned = cleaned.slice(0, 128);
  }
  return cleaned;
}

/**
 * Resolve duplicate column names after sanitization.
 * @param {string[]} names
 * @returns {string[]}
 */
function dedupeColumnNames(names) {
  const used = Object.create(null);
  return names.map((raw) => {
    const base = sanitizeColumnName(raw);
    let candidate = base;
    let i = 1;
    while (used[candidate]) {
      candidate = `${base}_${++i}`;
    }
    used[candidate] = true;
    return candidate;
  });
}

/**
 * @param {{ sqlName: string, logicalType: string, sqlType: unknown, sqlDeclaration: string }} column
 * @param {string} logical one of LOGICAL.* accepted by logicalToSql
 */
function applyLogicalToColumn(column, logical) {
  const { sqlType, declaration } = logicalToSql(logical);
  column.logicalType = logical;
  column.sqlType = sqlType;
  column.sqlDeclaration = declaration;
}

/**
 * Inquirer-friendly list for manual column type overrides.
 * @returns {{ name: string, value: string }[]}
 */
function getEditableLogicalTypeChoices() {
  return [
    { name: 'NVARCHAR(MAX) — text, JSON, arrays, objects', value: LOGICAL.STRING },
    { name: 'FLOAT — numbers', value: LOGICAL.NUMBER },
    { name: 'BIT — true / false', value: LOGICAL.BOOLEAN },
    { name: 'DATETIME2 — dates', value: LOGICAL.DATE },
    { name: 'VARCHAR(24) — Mongo ObjectId hex', value: LOGICAL.OBJECT_ID },
  ];
}

module.exports = {
  LOGICAL,
  mergeLogicalTypes,
  logicalToSql,
  detectedToLogical,
  sanitizeColumnName,
  dedupeColumnNames,
  applyLogicalToColumn,
  getEditableLogicalTypeChoices,
};
