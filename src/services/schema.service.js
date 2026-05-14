const { flattenDocument } = require('../utils/flatten');
const { inferSchemaFromSamples } = require('../utils/schemaInference');
const { coerceValueForBulkColumn } = require('../utils/bulkCoercion');

/**
 * Schema sampling and inference orchestration.
 */
class SchemaService {
  /**
   * @param {import('./mongo.service').MongoService} mongo
   * @param {string} collectionName
   * @param {number} sampleSize
   * @returns {Promise<import('../utils/schemaInference').InferredColumn[]>}
   */
  async inferFromCollection(mongo, collectionName, sampleSize) {
    const coll = mongo.collection(collectionName);
    const docs = await coll.find({}).limit(sampleSize).toArray();
    if (!docs.length) {
      return [];
    }
    return inferSchemaFromSamples(docs);
  }

  /**
   * Infer columns from an in-memory document array (e.g. JSON / Extended JSON export).
   * @param {import('mongodb').Document[]} documents
   * @param {number} sampleSize
   * @returns {import('../utils/schemaInference').InferredColumn[]}
   */
  inferFromDocumentArray(documents, sampleSize) {
    const n = Math.max(0, Math.floor(sampleSize));
    const sample = documents.slice(0, n);
    if (!sample.length) {
      return [];
    }
    return inferSchemaFromSamples(sample);
  }

  /**
   * Transform a Mongo document to a flat row aligned with inferred columns.
   * @param {import('../utils/schemaInference').InferredColumn[]} columns
   * @param {import('mongodb').Document} doc
   * @returns {Record<string, unknown>}
   */
  documentToRow(columns, doc) {
    const flat = flattenDocument(doc);
    /** @type {Record<string, unknown>} */
    const row = {};
    for (const col of columns) {
      const present = Object.prototype.hasOwnProperty.call(flat, col.sourceKey);
      const v = present ? flat[col.sourceKey] : null;
      row[col.sqlName] = coerceValueForBulkColumn(col.logicalType, v);
    }
    return row;
  }
}

module.exports = { SchemaService };
