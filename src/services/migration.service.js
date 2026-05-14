const chalk = require('chalk');
const ora = require('ora');
const { reserveSrnoColumnName, normalizeIdColumn } = require('./sql.service');

/**
 * @typedef {'overwrite'|'append'|'skip'} MigrationMode
 */

/**
 * Simple concurrency limiter for parallel collection migrations.
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  if (items.length === 0) {
    return [];
  }
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Orchestrates schema inference, DDL, cursor streaming, bulk inserts, and validation.
 */
class MigrationService {
  /**
   * @param {import('./mongo.service').MongoService} mongo
   * @param {import('./sql.service').SqlService} sql
   * @param {import('./schema.service').SchemaService} schema
   * @param {import('./logger.service').Logger} logger
   */
  constructor(mongo, sql, schema, logger) {
    this.mongo = mongo;
    this.sql = sql;
    this.schema = schema;
    this.logger = logger;
  }

  /**
   * @param {object} params
   * @param {string} params.collectionName
   * @param {string} params.tableName
   * @param {MigrationMode} params.mode
   * @param {number} params.batchSize
   * @param {number} params.schemaSampleSize
   * @param {boolean} [params.dryRun]
   * @param {boolean} [params.previewSql]
   * @param {boolean} [params.quietUi] when true, skip ora (parallel runs corrupt spinners)
   * @param {object[]|null} [params.precomputedColumns] if set, skip inference and use these columns (from CLI review)
   * @param {import('mongodb').Document[]|undefined} [params.sourceDocuments] when set, migrate this array instead of reading MongoDB
   * @returns {Promise<object>}
   */
  async migrateCollection({
    collectionName,
    tableName,
    mode,
    batchSize,
    schemaSampleSize,
    dryRun = false,
    previewSql = false,
    quietUi = false,
    precomputedColumns = null,
    sourceDocuments = undefined,
  }) {
    const started = Date.now();
    let inserted = 0;
    let failed = 0;
    let batches = 0;

    const fromInMemory = Array.isArray(sourceDocuments);
    const mongoCount = fromInMemory
      ? sourceDocuments.length
      : await this.mongo.countDocuments(collectionName);
    const exists = await this.sql.tableExists(tableName);

    if (mode === 'skip' && exists) {
      this.logger.warn(`Skipping "${collectionName}" → "${tableName}" (table exists, mode=skip).`);
      return {
        collectionName,
        tableName,
        mode,
        skipped: true,
        mongoCount,
        sqlCount: await this.sql.getRowCount(tableName).catch(() => 0),
        inserted: 0,
        failed: 0,
        batches: 0,
        durationMs: Date.now() - started,
      };
    }

    /** @type {object[]} */
    let columns;
    if (precomputedColumns && precomputedColumns.length) {
      columns = precomputedColumns.map((c) => ({ ...c, sqlType: c.sqlType }));
    } else {
      const inferSpin = quietUi ? null : ora({ text: 'Analyzing schema...', color: 'cyan' }).start();
      if (fromInMemory) {
        columns = this.schema.inferFromDocumentArray(sourceDocuments, schemaSampleSize);
      } else {
        columns = await this.schema.inferFromCollection(
          this.mongo,
          collectionName,
          schemaSampleSize,
        );
      }

      if (!columns.length) {
        if (mongoCount === 0) {
          if (inferSpin) {
            inferSpin.warn('No schema to infer (empty input).');
          }
          this.logger.warn(
            fromInMemory
              ? `No documents in JSON input for "${collectionName}"; nothing to migrate.`
              : `Collection "${collectionName}" is empty; no schema to infer. Nothing to migrate.`,
          );
          return {
            collectionName,
            tableName,
            mode,
            skipped: true,
            mongoCount,
            sqlCount: exists ? await this.sql.getRowCount(tableName) : 0,
            inserted: 0,
            failed: 0,
            batches: 0,
            durationMs: Date.now() - started,
          };
        }
        if (inferSpin) {
          inferSpin.fail('Schema inference produced no columns.');
        }
        throw new Error(
          fromInMemory
            ? `Schema inference returned zero columns for non-empty JSON input "${collectionName}".`
            : `Schema inference returned zero columns for non-empty collection "${collectionName}".`,
        );
      }

      if (inferSpin) {
        inferSpin.succeed('Schema analysis complete.');
      }
    }

    if (!columns.length) {
      this.logger.warn(`No columns available for "${collectionName}" → "${tableName}". Skipping.`);
      return {
        collectionName,
        tableName,
        mode,
        skipped: true,
        mongoCount,
        sqlCount: exists ? await this.sql.getRowCount(tableName).catch(() => 0) : 0,
        inserted: 0,
        failed: 0,
        batches: 0,
        durationMs: Date.now() - started,
      };
    }

    // Reserve `<tableName>_srno` for the auto-injected IDENTITY primary key.
    // If a Mongo field happens to flatten to that exact SQL name, rename it
    // here so both the CREATE TABLE DDL and the per-row bulk payload stay
    // consistent. Also pin `_id` to VARCHAR(64) so the UNIQUE constraint is
    // valid and the bulk driver agrees with the DDL.
    reserveSrnoColumnName(tableName, columns);
    normalizeIdColumn(columns);

    const ddl = this.sql.buildCreateTableDdl(tableName, columns);
    if (previewSql) {
      console.log(chalk.gray('--- SQL preview (CREATE TABLE) ---'));
      console.log(chalk.gray(ddl));
      console.log(chalk.gray('----------------------------------'));
    }

    const driverColumns = columns.map((c) => ({
      sqlName: c.sqlName,
      sqlType: c.sqlType,
      nullable: c.nullable,
    }));

    if (dryRun) {
      this.logger.info(
        `[DRY RUN] Would migrate ${mongoCount} documents from "${collectionName}" into "${tableName}" (${columns.length} columns).`,
      );
      return {
        collectionName,
        tableName,
        mode,
        dryRun: true,
        mongoCount,
        sqlCount: null,
        inserted: 0,
        failed: 0,
        batches: 0,
        durationMs: Date.now() - started,
        ddl,
      };
    }

    const ddlSpin = quietUi ? null : ora({ text: 'Generating SQL table...', color: 'cyan' }).start();
    if (mode === 'overwrite') {
      await this.sql.dropTableIfExists(tableName);
      await this.sql.createTable(tableName, columns);
    } else if (mode === 'append') {
      if (!exists) {
        await this.sql.createTable(tableName, columns);
      }
    }
    if (ddlSpin) {
      ddlSpin.succeed(exists && mode === 'append' ? 'Using existing table (append mode).' : 'SQL table ready.');
    } else {
      this.logger.info(
        `Table ready: ${tableName} (${exists && mode === 'append' ? 'append to existing' : 'created or replaced'})`,
      );
    }

    if (mongoCount === 0) {
      this.logger.info(
        fromInMemory
          ? `JSON input "${collectionName}" has zero documents; table is ready.`
          : `Collection "${collectionName}" has zero documents; table is ready.`,
      );
      const sqlCount = await this.sql.getRowCount(tableName);
      return {
        collectionName,
        tableName,
        mode,
        mongoCount,
        sqlCount,
        inserted: 0,
        failed: 0,
        batches: 0,
        durationMs: Date.now() - started,
      };
    }

    const migrateSpin = quietUi ? null : ora({ text: 'Migrating data...', color: 'cyan' }).start();
    /** @type {Record<string, unknown>[]} */
    let buffer = [];

    const flushBuffer = async () => {
      if (!buffer.length) {
        return;
      }
      const rows = buffer;
      buffer = [];
      batches += 1;
      const batchStart = Date.now();
      try {
        await this.sql.bulkInsertBatch(tableName, driverColumns, rows);
        inserted += rows.length;
        if (migrateSpin) {
          migrateSpin.text = `Migrating data... (${inserted} rows)`;
        }
        this.logger.batch({
          collection: collectionName,
          table: tableName,
          batch: batches,
          inserted: rows.length,
          failed: 0,
          ms: Date.now() - batchStart,
        });
      } catch (err) {
        failed += rows.length;
        this.logger.error(
          `Bulk insert failed for ${collectionName} batch ${batches} (${rows.length} rows)`,
          err,
        );
        this.logger.batch({
          collection: collectionName,
          table: tableName,
          batch: batches,
          inserted: 0,
          failed: rows.length,
          ms: Date.now() - batchStart,
        });
      }
    };

    if (fromInMemory) {
      for (const doc of sourceDocuments) {
        buffer.push(this.schema.documentToRow(columns, doc));
        if (buffer.length >= batchSize) {
          await flushBuffer();
        }
      }
    } else {
      const cursor = this.mongo.createReadCursor(collectionName, batchSize);
      try {
        for await (const doc of cursor) {
          buffer.push(this.schema.documentToRow(columns, doc));
          if (buffer.length >= batchSize) {
            await flushBuffer();
          }
        }
      } finally {
        await cursor.close();
      }
    }

    await flushBuffer();

    if (migrateSpin) {
      migrateSpin.succeed(`Data migration finished (${inserted} inserted, ${failed} failed).`);
    }

    const sqlCount = await this.sql.getRowCount(tableName);
    const durationMs = Date.now() - started;

    this.logger.success(
      `Finished "${collectionName}" → "${tableName}" | inserted=${inserted} failed=${failed} batches=${batches} durationMs=${durationMs}`,
    );

    return {
      collectionName,
      tableName,
      mode,
      mongoCount,
      sqlCount,
      inserted,
      failed,
      batches,
      durationMs,
    };
  }

  /**
   * @param {{ collectionName: string, tableName: string, mode: MigrationMode, columns?: object[], sourceDocuments?: import('mongodb').Document[] }[]} jobs
   * @param {object} opts
   * @param {number} opts.batchSize
   * @param {number} opts.schemaSampleSize
   * @param {number} opts.concurrency
   * @param {boolean} [opts.dryRun]
   * @param {boolean} [opts.previewSql]
   * @returns {Promise<object[]>}
   */
  async migrateMany(jobs, { batchSize, schemaSampleSize, concurrency, dryRun, previewSql }) {
    const quietUi = jobs.length > 1 && concurrency > 1;
    return mapLimit(jobs, Math.max(1, concurrency), (job) =>
      this.migrateCollection({
        collectionName: job.collectionName,
        tableName: job.tableName,
        mode: job.mode,
        batchSize,
        schemaSampleSize,
        dryRun,
        previewSql,
        quietUi,
        precomputedColumns: job.columns && job.columns.length ? job.columns : null,
        sourceDocuments: Array.isArray(job.sourceDocuments) ? job.sourceDocuments : undefined,
      }),
    );
  }
}

module.exports = { MigrationService, mapLimit };
