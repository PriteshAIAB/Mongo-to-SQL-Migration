/**
 * Centralized environment configuration with validation.
 * All runtime settings are loaded from process.env (typically via dotenv).
 */

require('dotenv').config();

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(v).trim();
}

function optionalInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n) || n < 1) {
    return defaultValue;
  }
  return n;
}

function optionalBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

const config = {
  mongo: {
    uri: requireEnv('MONGO_URI'),
    database: requireEnv('MONGO_DB'),
  },
  sql: {
    user: requireEnv('SQL_USER'),
    password: requireEnv('SQL_PASSWORD'),
    server: requireEnv('SQL_SERVER'),
    database: requireEnv('SQL_DATABASE'),
    port: optionalInt('SQL_PORT', 1433),
    options: {
      encrypt: String(process.env.SQL_ENCRYPT || '').toLowerCase() === 'true',
      trustServerCertificate: String(process.env.SQL_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() !== 'false',
    },
  },
  migration: {
    batchSize: optionalInt('BATCH_SIZE', 1000),
    schemaSampleSize: optionalInt('SCHEMA_SAMPLE_SIZE', 100),
    concurrency: optionalInt('MIGRATION_CONCURRENCY', 2),
    /** When true, no CREATE TABLE / bulk insert (set in .env only) */
    dryRun: optionalBool('DRY_RUN', false),
    logToFile: optionalBool('LOG_TO_FILE', false),
    sqlPreview: optionalBool('SQL_PREVIEW', true),
  },
};

module.exports = { config, requireEnv, optionalInt, optionalBool };
