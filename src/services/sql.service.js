const sql = require('mssql');

/**
 * Validate SQL Server table identifier (no brackets/parameters in identifiers).
 * @param {string} name
 * @returns {string}
 */
function assertSafeTableName(name) {
  const s = String(name).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(
      `Invalid table name "${name}". Use letters, numbers, and underscores only; must start with letter or underscore.`,
    );
  }
  return s;
}

/**
 * Bracket-quote identifier for T-SQL.
 * @param {string} name
 * @returns {string}
 */
function bracket(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

/**
 * SQL name of the auto-injected surrogate primary key column for a table.
 * @param {string} tableName
 * @returns {string}
 */
function srnoColumnName(tableName) {
  return `${assertSafeTableName(tableName)}_srno`;
}

/**
 * Force the `_id` column to a fixed, indexable shape (VARCHAR(64)) so the
 * UNIQUE constraint emitted by `buildCreateTableDdl` is valid and the bulk
 * driver agrees on the type. Mutates and returns the same columns array.
 * @param {{ sqlName: string, sqlType: unknown, sqlDeclaration: string, logicalType?: string }[]} columns
 * @returns {{ sqlName: string }[]}
 */
function normalizeIdColumn(columns) {
  for (const col of columns) {
    if (col.sqlName !== '_id') {
      continue;
    }
    col.sqlType = sql.VarChar(64);
    col.sqlDeclaration = 'VARCHAR(64)';
    // Logical type stays whatever was inferred (string / objectId); coercion
    // still produces a JS string, which is what VarChar bulk load wants.
  }
  return columns;
}

/**
 * If an inferred column collides with the reserved `<tableName>_srno` name,
 * rename it (and any cascade collisions) so the IDENTITY column stays unique.
 * Mutates and returns the same columns array.
 * @param {string} tableName
 * @param {{ sqlName: string }[]} columns
 * @returns {{ sqlName: string }[]}
 */
function reserveSrnoColumnName(tableName, columns) {
  const reserved = srnoColumnName(tableName);
  const used = new Set(columns.map((c) => c.sqlName));

  for (const col of columns) {
    if (col.sqlName !== reserved) {
      continue;
    }
    let i = 2;
    let candidate = `${reserved}_${i}`;
    while (used.has(candidate)) {
      i += 1;
      candidate = `${reserved}_${i}`;
    }
    used.delete(col.sqlName);
    col.sqlName = candidate;
    used.add(candidate);
  }

  return columns;
}

/**
 * MSSQL pool, DDL, counts, and bulk insert via sql.Table.
 */
class SqlService {
  constructor() {
    /** @type {sql.ConnectionPool|null} */
    this.pool = null;
  }

  /**
   * @param {{ user: string, password: string, server: string, database: string, port: number, options?: object }} cfg
   */
  async connect(cfg) {
    this.pool = await sql.connect({
      user: cfg.user,
      password: cfg.password,
      server: cfg.server,
      database: cfg.database,
      port: cfg.port,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
      connectionTimeout: 30_000,
      requestTimeout: 120_000,
      options: {
        encrypt: cfg.options?.encrypt ?? false,
        trustServerCertificate: cfg.options?.trustServerCertificate ?? true,
      },
    });
  }

  async close() {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  /**
   * @param {string} tableName
   * @returns {Promise<boolean>}
   */
  async tableExists(tableName) {
    const t = assertSafeTableName(tableName);
    const r = await this.pool
      .request()
      .input('t', sql.NVarChar, t)
      .query(
        `SELECT 1 AS x FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @t`,
      );
    return r.recordset.length > 0;
  }

  /**
   * @param {string} tableName
   * @returns {Promise<number>}
   */
  async getRowCount(tableName) {
    const t = assertSafeTableName(tableName);
    const q = `SELECT COUNT_BIG(*) AS c FROM ${bracket('dbo')}.${bracket(t)}`;
    const r = await this.pool.request().query(q);
    return Number(r.recordset[0].c);
  }

  /**
   * @param {string} tableName
   */
  async dropTableIfExists(tableName) {
    const t = assertSafeTableName(tableName);
    const q = `IF OBJECT_ID(N'dbo.${t}', N'U') IS NOT NULL DROP TABLE ${bracket('dbo')}.${bracket(t)};`;
    await this.pool.request().query(q);
  }

  /**
   * Build CREATE TABLE DDL with an auto-injected `<tableName>_srno` IDENTITY
   * primary key and a UNIQUE constraint on `_id` for fast post-migration
   * foreign-key resolution. All inferred columns are emitted as NOT NULL;
   * missing Mongo values are substituted with safe defaults at bulk-insert
   * time (see utils/bulkCoercion.js).
   *
   * `_id` is forced to `VARCHAR(64)` regardless of inferred type so the
   * UNIQUE constraint is valid (SQL Server cannot index NVARCHAR(MAX)) and so
   * it works for ObjectId hex (24), UUID (36), and short custom string ids.
   *
   * @param {string} tableName
   * @param {{ sqlName: string, sqlDeclaration: string, nullable: boolean }[]} columns
   * @returns {string}
   */
  buildCreateTableDdl(tableName, columns) {
    const t = assertSafeTableName(tableName);
    reserveSrnoColumnName(t, columns);
    normalizeIdColumn(columns);

    const lines = [
      `${bracket(srnoColumnName(t))} BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY`,
    ];
    for (const c of columns) {
      const trailing = c.sqlName === '_id' ? 'NOT NULL UNIQUE' : 'NOT NULL';
      lines.push(`${bracket(c.sqlName)} ${c.sqlDeclaration} ${trailing}`);
    }
    return `CREATE TABLE ${bracket('dbo')}.${bracket(t)} (\n  ${lines.join(',\n  ')}\n);`;
  }

  /**
   * @param {string} tableName
   * @param {{ sqlName: string, sqlDeclaration: string, nullable: boolean }[]} columns
   * @returns {Promise<string>} executed CREATE TABLE script
   */
  async createTable(tableName, columns) {
    const ddl = this.buildCreateTableDdl(tableName, columns);
    await this.pool.request().query(ddl);
    return ddl;
  }

  /**
   * Bulk insert rows using mssql.Table (single request per batch).
   * @param {string} tableName
   * @param {{ sqlName: string, sqlType: import('mssql').ISqlType, nullable: boolean }[]} columns
   * @param {Record<string, unknown>[]} rows
   */
  async bulkInsertBatch(tableName, columns, rows) {
    if (!rows.length) {
      return;
    }
    const t = assertSafeTableName(tableName);
    const table = new sql.Table(t);
    table.schema = 'dbo';
    table.create = false;

    for (const col of columns) {
      table.columns.add(col.sqlName, col.sqlType, { nullable: col.nullable });
    }

    for (const row of rows) {
      const vals = columns.map((c) => {
        const v = row[c.sqlName];
        return v === undefined ? null : v;
      });
      table.rows.add(...vals);
    }

    await this.pool.request().bulk(table);
  }
}

module.exports = {
  SqlService,
  assertSafeTableName,
  bracket,
  srnoColumnName,
  reserveSrnoColumnName,
  normalizeIdColumn,
};
