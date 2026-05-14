const { ObjectId } = require('mongodb');

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObjectId(value) {
  return value instanceof ObjectId;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function objectIdToString(value) {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return null;
}

module.exports = { ObjectId, isObjectId, objectIdToString };
