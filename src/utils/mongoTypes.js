const { Decimal128, Binary, Long, Int32 } = require('mongodb');
const { isDate } = require('./dateConvert');
const { isObjectId } = require('./objectId');

/**
 * High-level BSON/JS type label used for schema inference and SQL mapping.
 * @param {unknown} value
 * @returns {string}
 */
function detectMongoType(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (isObjectId(value)) {
    return 'objectId';
  }
  if (isDate(value)) {
    return 'date';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return 'number';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value instanceof Decimal128) {
    return 'decimal128';
  }
  if (value instanceof Long || value instanceof Int32) {
    return 'number';
  }
  if (value instanceof Binary) {
    return 'binary';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return 'unknown';
}

module.exports = { detectMongoType };
