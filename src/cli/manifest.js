const fs = require('fs');
const path = require('path');
const { EJSON } = require('bson');
const { assertSafeTableName } = require('../services/sql.service');

const VALID_MODES = new Set(['overwrite', 'append', 'skip']);

/**
 * Resolve a user-supplied path relative to cwd when not absolute.
 * @param {string} userPath
 * @returns {string}
 */
function resolveManifestPath(userPath) {
  const trimmed = String(userPath || '').trim();
  if (!trimmed) {
    throw new Error('Manifest path is empty.');
  }
  return path.isAbsolute(trimmed) ? trimmed : path.join(process.cwd(), trimmed);
}

/**
 * @param {string} absPath
 * @returns {object}
 */
function loadManifestDocument(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Manifest file not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in manifest: ${e.message}`);
  }
}

/**
 * @param {object} doc
 * @param {string[]} availableCollectionNames from MongoDB
 * @returns {{ jobs: { collectionName: string, tableName: string, mode: string }[], skipSchemaReview: boolean }}
 */
/**
 * Deserialize Mongo Extended JSON rows to BSON-style documents.
 * @param {unknown[]} rows
 * @param {string} contextLabel e.g. "index" or "documents[i]"
 * @returns {import('mongodb').Document[]}
 */
function deserializeExtendedJsonRows(rows, contextLabel) {
  /** @type {import('mongodb').Document[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      out.push(EJSON.deserialize(row));
    } catch (e) {
      throw new Error(`Invalid Extended JSON at ${contextLabel}[${i}]: ${e.message}`);
    }
  }
  return out;
}

/**
 * Detect manifest shape: Mongo job list vs in-memory document export.
 * @param {unknown} parsed root from JSON.parse
 * @param {string} absPath absolute path to file (for labels)
 * @returns {{ kind: 'mongoJobs', doc: object } | { kind: 'documentExport', documents: import('mongodb').Document[], sourceLabel: string, table: string|null, defaultMode: string|null, skipSchemaReview: boolean }}
 */
function classifyManifestPayload(parsed, absPath) {
  const sourceLabel = path.basename(absPath);

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error(
        'JSON array is empty. Add documents, or use { "jobs": [...] } for MongoDB collection migration.',
      );
    }
    if (!parsed.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      throw new Error('JSON array must contain only objects (one object per MongoDB document).');
    }
    const documents = deserializeExtendedJsonRows(parsed, 'array');
    return {
      kind: 'documentExport',
      documents,
      sourceLabel,
      table: null,
      defaultMode: null,
      skipSchemaReview: false,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Manifest must be a JSON object or an array of documents.');
  }

  const doc = /** @type {Record<string, unknown>} */ (parsed);

  if (Array.isArray(doc.jobs) && doc.jobs.length > 0) {
    return { kind: 'mongoJobs', doc };
  }

  if (Array.isArray(doc.jobs) && doc.jobs.length === 0) {
    throw new Error('Manifest "jobs" array is empty. Add jobs or use a document array / "documents" export.');
  }

  if (Array.isArray(doc.documents)) {
    if (doc.documents.length === 0) {
      throw new Error('Property "documents" is an empty array. Add at least one document.');
    }
    if (!doc.documents.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      throw new Error('"documents" must be an array of objects only.');
    }
    const documents = deserializeExtendedJsonRows(doc.documents, 'documents');
    const tableRaw = doc.table ?? doc.tableName;
    let table = null;
    if (tableRaw != null && String(tableRaw).trim()) {
      table = String(tableRaw).trim();
      assertSafeTableName(table);
    }
    const defaultMode = doc.defaultMode != null ? String(doc.defaultMode).trim() : null;
    if (defaultMode && !VALID_MODES.has(defaultMode)) {
      throw new Error(`Invalid defaultMode "${defaultMode}". Use overwrite, append, or skip.`);
    }
    return {
      kind: 'documentExport',
      documents,
      sourceLabel,
      table,
      defaultMode,
      skipSchemaReview: Boolean(doc.skipSchemaReview),
    };
  }

  throw new Error(
    'Unrecognized JSON format. Use one of: (1) { "jobs": [...] } with Mongo collection names, ' +
      '(2) a JSON array of documents [ {...}, ... ], or (3) { "table": "...", "documents": [...] } (table optional).',
  );
}

function validateAndNormalizeManifest(doc, availableCollectionNames) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Manifest root must be a JSON object.');
  }

  const jobsIn = doc.jobs;
  if (!Array.isArray(jobsIn) || jobsIn.length === 0) {
    throw new Error('Manifest must include a non-empty "jobs" array.');
  }

  const available = new Set(availableCollectionNames);
  const defaultMode = doc.defaultMode != null ? String(doc.defaultMode).trim() : 'overwrite';
  if (!VALID_MODES.has(defaultMode)) {
    throw new Error(`Invalid defaultMode "${defaultMode}". Use overwrite, append, or skip.`);
  }

  /** @type {{ collectionName: string, tableName: string, mode: string }[]} */
  const jobs = [];

  for (let i = 0; i < jobsIn.length; i++) {
    const j = jobsIn[i];
    if (!j || typeof j !== 'object') {
      throw new Error(`jobs[${i}] must be an object.`);
    }
    const collectionName = j.collection ?? j.collectionName;
    const tableName = j.table ?? j.tableName;
    if (!collectionName || typeof collectionName !== 'string') {
      throw new Error(`jobs[${i}]: missing string "collection" (or "collectionName").`);
    }
    if (!tableName || typeof tableName !== 'string') {
      throw new Error(`jobs[${i}]: missing string "table" (or "tableName").`);
    }
    if (!available.has(collectionName)) {
      throw new Error(
        `jobs[${i}]: collection "${collectionName}" does not exist in this MongoDB database.`,
      );
    }
    assertSafeTableName(tableName.trim());

    const modeRaw = j.mode != null ? String(j.mode).trim() : defaultMode;
    if (!VALID_MODES.has(modeRaw)) {
      throw new Error(`jobs[${i}]: invalid mode "${modeRaw}". Use overwrite, append, or skip.`);
    }

    jobs.push({
      collectionName: collectionName.trim(),
      tableName: tableName.trim(),
      mode: modeRaw,
    });
  }

  return {
    jobs,
    skipSchemaReview: Boolean(doc.skipSchemaReview),
  };
}

/**
 * @returns {string|null}
 */
function getManifestPathFromArgv() {
  const a = process.argv.slice(2);
  const idx = a.findIndex((x) => x === '--manifest' || x === '-m');
  if (idx >= 0 && a[idx + 1]) {
    return resolveManifestPath(a[idx + 1]);
  }
  return null;
}

module.exports = {
  resolveManifestPath,
  loadManifestDocument,
  validateAndNormalizeManifest,
  classifyManifestPayload,
  getManifestPathFromArgv,
  VALID_MODES,
};
