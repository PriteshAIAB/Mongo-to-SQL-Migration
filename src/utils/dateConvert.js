/**
 * Normalize MongoDB/BSON Date values for MSSQL DATETIME2.
 * @param {Date} date
 * @returns {Date}
 */
function toSqlDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return date;
  }
  return date;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

module.exports = { toSqlDateTime, isDate };
