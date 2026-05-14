const { flattenDocument } = require('./flatten');
const { detectMongoType } = require('./mongoTypes');
const {
  mergeLogicalTypes,
  detectedToLogical,
  logicalToSql,
  dedupeColumnNames,
  LOGICAL,
} = require('./sqlTypes');

/**
 * @typedef {Object} InferredColumn
 * @property {string} sourceKey
 * @property {string} sqlName
 * @property {string} logicalType
 * @property {boolean} nullable
 * @property {import('mssql').ISqlTypeFactoryWithNoParams | import('mssql').ISqlTypeFactoryWithLength | import('mssql').ISqlTypeFactoryWithPrecisionScale} sqlType
 * @property {string} sqlDeclaration
 */

/**
 * Infer column definitions from a sample of MongoDB documents.
 * @param {Record<string, unknown>[]} docs
 * @returns {InferredColumn[]}
 */
function inferSchemaFromSamples(docs) {
  /** @type {Map<string, string|null>} */
  const acc = new Map();

  for (const doc of docs) {
    const flat = flattenDocument(doc);
    for (const [key, value] of Object.entries(flat)) {
      const detected = detectMongoType(value);
      const logical = detectedToLogical(detected);
      const prev = acc.get(key) ?? null;
      const mergedLogical = mergeLogicalTypes(prev, logical);
      acc.set(key, mergedLogical);
    }
  }

  const sourceKeys = [...acc.keys()];
  const sqlNames = dedupeColumnNames(sourceKeys);

  /** @type {InferredColumn[]} */
  const columns = [];
  sourceKeys.forEach((sourceKey, idx) => {
    const merged = acc.get(sourceKey);
    const logical =
      !merged || merged === LOGICAL.NULL ? LOGICAL.STRING : merged;
    const { sqlType, declaration } = logicalToSql(logical);
    columns.push({
      sourceKey,
      sqlName: sqlNames[idx],
      logicalType: logical,
      // All columns are emitted as NOT NULL; missing Mongo values are
      // substituted with type-appropriate safe defaults at bulk-insert time
      // (see utils/bulkCoercion.js).
      nullable: false,
      sqlType,
      sqlDeclaration: declaration,
    });
  });

  return columns;
}

module.exports = { inferSchemaFromSamples };
