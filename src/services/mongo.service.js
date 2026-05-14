const { MongoClient } = require('mongodb');

/**
 * MongoDB access: connection, discovery, counts, and cursor-based reads.
 */
class MongoService {
  constructor() {
    /** @type {MongoClient|null} */
    this.client = null;
    /** @type {import('mongodb').Db|null} */
    this.db = null;
  }

  /**
   * @param {string} uri
   * @param {string} databaseName
   */
  async connect(uri, databaseName) {
    this.client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30_000,
      connectTimeoutMS: 30_000,
    });
    await this.client.connect();
    this.db = this.client.db(databaseName);
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  /**
   * @returns {Promise<string[]>}
   */
  async listUserCollections() {
    if (!this.db) {
      throw new Error('MongoDB is not connected');
    }
    const cols = await this.db.listCollections({ type: 'collection' }).toArray();
    return cols.map((c) => c.name).sort((a, b) => a.localeCompare(b));
  }

  /**
   * @param {string} name
   * @returns {import('mongodb').Collection<import('mongodb').Document>}
   */
  collection(name) {
    if (!this.db) {
      throw new Error('MongoDB is not connected');
    }
    return this.db.collection(name);
  }

  /**
   * @param {string} name
   * @returns {Promise<number>}
   */
  async countDocuments(name) {
    return this.collection(name).countDocuments();
  }

  /**
   * Streaming cursor with projection disabled (full docs).
   * @param {string} name
   * @param {number} batchSize
   * @returns {import('mongodb').FindCursor<import('mongodb').WithId<import('mongodb').Document>>}
   */
  createReadCursor(name, batchSize) {
    return this.collection(name).find({}, { batchSize });
  }
}

module.exports = { MongoService };
