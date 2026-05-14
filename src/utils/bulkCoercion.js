const { ObjectId, Long, Int32, Decimal128 } = require('mongodb');
const { LOGICAL } = require('./sqlTypes');

/**
 * Placeholder for `_id`-style columns when a value is missing or malformed.
 * 24 zero-hex chars stay within VARCHAR(24) and are easy to spot in SQL.
 */
const ZERO_OBJECT_ID = '000000000000000000000000';

/**
 * DBA-friendly sentinel for NOT NULL DATETIME2 columns when Mongo lacked the field.
 * `1900-01-01` is the classic SQL Server "no date" placeholder.
 */
const DEFAULT_DATE = new Date('1900-01-01T00:00:00.000Z');

/**
 * Safe default value to insert when a Mongo document is missing a column
 * (or the value cannot be coerced) and the SQL column is NOT NULL.
 * @param {string} logicalType
 * @returns {unknown}
 */
function defaultValueForLogical(logicalType) {
  switch (logicalType) {
    case LOGICAL.BOOLEAN:
      return false;
    case LOGICAL.NUMBER:
      return 0;
    case LOGICAL.DATE:
      return DEFAULT_DATE;
    case LOGICAL.OBJECT_ID:
      return ZERO_OBJECT_ID;
    case LOGICAL.STRING:
    case LOGICAL.ARRAY:
    case LOGICAL.OBJECT:
    case LOGICAL.BINARY:
    case LOGICAL.UNKNOWN:
    case LOGICAL.DECIMAL128:
    default:
      return '';
  }
}

/**
 * Coerce a flattened Mongo value to what node-mssql / tedious bulk load expects per column.
 * VARCHAR/NVarChar validate with typeof === 'string' — numbers/objects caused "Invalid string."
 *
 * All inferred columns are NOT NULL, so this function NEVER returns null /
 * undefined; missing or un-coercible values are substituted with the
 * type-appropriate default from `defaultValueForLogical`.
 *
 * @param {string} logicalType
 * @param {unknown} v
 * @returns {unknown}
 */
function coerceValueForBulkColumn(logicalType, v) {
  if (v === undefined || v === null) {
    return defaultValueForLogical(logicalType);
  }

  switch (logicalType) {
    case LOGICAL.BOOLEAN:
      return Boolean(v);

    case LOGICAL.NUMBER: {
      if (typeof v === 'number' && Number.isFinite(v)) {
        return v;
      }
      if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : defaultValueForLogical(logicalType);
      }
      if (v instanceof Long || v instanceof Int32) {
        return Number(v);
      }
      if (v instanceof Decimal128) {
        const n = Number(v.toString());
        return Number.isFinite(n) ? n : defaultValueForLogical(logicalType);
      }
      return defaultValueForLogical(logicalType);
    }

    case LOGICAL.DATE: {
      if (v instanceof Date && !Number.isNaN(v.getTime())) {
        return v;
      }
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? defaultValueForLogical(logicalType) : d;
    }

    case LOGICAL.OBJECT_ID: {
      if (v instanceof ObjectId) {
        return v.toHexString();
      }
      if (typeof v === 'string' && v.length) {
        return v;
      }
      if (v == null) {
        return defaultValueForLogical(logicalType);
      }
      const s = String(v);
      return s.length ? s : defaultValueForLogical(logicalType);
    }

    case LOGICAL.STRING:
    case LOGICAL.ARRAY:
    case LOGICAL.OBJECT:
    case LOGICAL.BINARY:
    case LOGICAL.UNKNOWN:
    case LOGICAL.DECIMAL128:
    default: {
      if (typeof v === 'string') {
        return v;
      }
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
        return String(v);
      }
      if (v instanceof Date) {
        return v.toISOString();
      }
      if (v instanceof ObjectId) {
        return v.toHexString();
      }
      if (v instanceof Long || v instanceof Int32) {
        return String(Number(v));
      }
      if (v instanceof Decimal128) {
        return v.toString();
      }
      if (Buffer.isBuffer(v)) {
        return v.toString('base64');
      }
      if (typeof v === 'object') {
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      }
      return String(v);
    }
  }
}

module.exports = { coerceValueForBulkColumn, defaultValueForLogical };
