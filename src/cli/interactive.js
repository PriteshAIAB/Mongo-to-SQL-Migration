const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const { assertSafeTableName } = require('../services/sql.service');
const { MigrationService } = require('../services/migration.service');
const { Logger } = require('../services/logger.service');
const { promptSchemaReview } = require('./schemaPrompt');
const {
  resolveManifestPath,
  loadManifestDocument,
  validateAndNormalizeManifest,
  classifyManifestPayload,
  getManifestPathFromArgv,
  VALID_MODES,
} = require('./manifest');

/**
 * @param {string} collectionName
 * @returns {string}
 */
function defaultSqlTableName(collectionName) {
  const base = String(collectionName)
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const withPrefix = base.match(/^[0-9]/) ? `tbl_${base}` : `tbl_${base}`;
  return withPrefix.replace(/__+/g, '_');
}

/**
 * @param {string} absJsonPath
 * @returns {string}
 */
function defaultSqlTableFromJsonPath(absJsonPath) {
  const base = path.basename(absJsonPath, path.extname(absJsonPath)) || 'export';
  return defaultSqlTableName(base);
}

/**
 * @param {string[]} collections
 */
function printCollectionBanner(collections) {
  console.log('');
  console.log(chalk.bold.cyan('===================================='));
  console.log(chalk.bold.cyan('MongoDB collections'));
  console.log(chalk.bold.cyan('===================================='));
  collections.forEach((c, i) => {
    console.log(chalk.white(`${i + 1}. ${c}`));
  });
  console.log('');
}

/**
 * @param {object} ctx
 * @param {import('../services/mongo.service').MongoService} ctx.mongo
 * @param {import('../services/schema.service').SchemaService} ctx.schema
 * @param {import('../config/env').config} ctx.cfg
 * @param {string[]} ctx.collections
 * @returns {Promise<{ collectionName: string, tableName: string, columns: object[] }[]>}
 */
async function buildJobsFromMongoPicker(ctx) {
  const { mongo, schema, cfg, collections } = ctx;
  printCollectionBanner(collections);

  const { selectedCollections } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedCollections',
      message: 'Select collection(s) to migrate (space toggles, enter confirms):',
      choices: collections.map((c, i) => ({
        name: `${i + 1}. ${c}`,
        value: c,
      })),
      validate: (selected) => (selected.length ? true : 'Pick at least one collection.'),
    },
  ]);

  /** @type {{ collectionName: string, tableName: string, columns: object[] }[]} */
  const jobs = [];

  for (const col of selectedCollections) {
    const { tableName: rawTable } = await inquirer.prompt([
      {
        type: 'input',
        name: 'tableName',
        message: `SQL table name for "${chalk.yellow(col)}":`,
        default: defaultSqlTableName(col),
        validate: (input) => {
          try {
            assertSafeTableName(String(input).trim());
            return true;
          } catch (e) {
            return e.message;
          }
        },
      },
    ]);
    const tableName = String(rawTable).trim();

    const mongoCount = await mongo.countDocuments(col);
    const inferSpin = ora({ text: `Sampling "${col}" for schema…`, color: 'cyan' }).start();
    const columns = await schema.inferFromCollection(mongo, col, cfg.migration.schemaSampleSize);
    inferSpin.succeed(`Schema sample ready (${columns.length} column(s), ~${mongoCount} document(s) in collection).`);

    if (!columns.length) {
      console.log(
        chalk.yellow(
          `\nSkipping "${col}" — no inferrable fields (empty collection or no documents in sample).\n`,
        ),
      );
      continue;
    }

    await promptSchemaReview(col, tableName, columns);

    jobs.push({
      collectionName: col,
      tableName,
      columns,
    });

    console.log(chalk.green(`\n✓ Queued: ${col} → ${tableName} (${columns.length} columns)\n`));
  }

  return jobs;
}

/**
 * @param {object} ctx
 * @param {string} ctx.absManifestPath
 * @param {import('../services/mongo.service').MongoService} ctx.mongo
 * @param {import('../services/schema.service').SchemaService} ctx.schema
 * @param {import('../config/env').config} ctx.cfg
 * @param {string[]} ctx.collections
 * @returns {Promise<{ collectionName: string, tableName: string, mode: string, columns: object[] }[]>}
 */
async function buildJobsFromManifest(ctx) {
  const { absManifestPath, mongo, schema, cfg, collections } = ctx;

  console.log(chalk.cyan(`\nLoading file: ${absManifestPath}\n`));

  const parsed = loadManifestDocument(absManifestPath);
  const spec = classifyManifestPayload(parsed, absManifestPath);

  /** @type {{ collectionName: string, tableName: string, mode: string, columns: object[], sourceDocuments?: import('mongodb').Document[] }[]} */
  const jobs = [];

  if (spec.kind === 'mongoJobs') {
    const { jobs: stubs, skipSchemaReview } = validateAndNormalizeManifest(spec.doc, collections);

    for (const stub of stubs) {
      const { collectionName: col, tableName, mode } = stub;

      const mongoCount = await mongo.countDocuments(col);
      const inferSpin = ora({ text: `Sampling "${col}" for schema…`, color: 'cyan' }).start();
      const columns = await schema.inferFromCollection(mongo, col, cfg.migration.schemaSampleSize);
      inferSpin.succeed(`Schema sample ready (${columns.length} column(s), ~${mongoCount} document(s)).`);

      if (!columns.length) {
        console.log(chalk.yellow(`\nSkipping "${col}" — no inferrable fields.\n`));
        continue;
      }

      if (!skipSchemaReview) {
        await promptSchemaReview(col, tableName, columns);
      }

      jobs.push({
        collectionName: col,
        tableName,
        mode,
        columns,
      });

      console.log(
        chalk.green(`\n✓ Queued: ${col} → ${tableName} (${columns.length} columns, mode=${mode})\n`),
      );
    }

    return jobs;
  }

  const { documents, sourceLabel, table: tableFromFile, defaultMode, skipSchemaReview } = spec;
  const virtualCollection = `json:${sourceLabel}`;

  let tableName = tableFromFile;
  if (!tableName) {
    const { tableName: rawTable } = await inquirer.prompt([
      {
        type: 'input',
        name: 'tableName',
        message: `SQL table name for JSON file "${chalk.yellow(sourceLabel)}":`,
        default: defaultSqlTableFromJsonPath(absManifestPath),
        validate: (input) => {
          try {
            assertSafeTableName(String(input).trim());
            return true;
          } catch (e) {
            return e.message;
          }
        },
      },
    ]);
    tableName = String(rawTable).trim();
  }

  let mode = defaultMode;
  if (!mode || !VALID_MODES.has(mode)) {
    const { mode: chosen } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'How should SQL Server handle the destination table?',
        choices: [
          { name: 'Overwrite — DROP IF EXISTS, CREATE table, load all rows', value: 'overwrite' },
          { name: 'Append — INSERT into existing table (CREATE only if missing)', value: 'append' },
          { name: 'Skip — do nothing if table already exists', value: 'skip' },
        ],
        default: 'overwrite',
      },
    ]);
    mode = chosen;
  }

  const inferSpin = ora({
    text: `Inferring schema from ${documents.length} document(s)…`,
    color: 'cyan',
  }).start();
  const columns = schema.inferFromDocumentArray(documents, cfg.migration.schemaSampleSize);
  inferSpin.succeed(
    `Schema ready (${columns.length} column(s), ${documents.length} document(s) in file).`,
  );

  if (!columns.length) {
    console.log(chalk.yellow(`\nSkipping "${sourceLabel}" — no inferrable fields.\n`));
    return jobs;
  }

  if (!skipSchemaReview) {
    await promptSchemaReview(virtualCollection, tableName, columns);
  }

  jobs.push({
    collectionName: virtualCollection,
    tableName,
    mode,
    columns,
    sourceDocuments: documents,
  });

  console.log(
    chalk.green(
      `\n✓ Queued: ${virtualCollection} → ${tableName} (${columns.length} columns, mode=${mode})\n`,
    ),
  );

  return jobs;
}

/**
 * @param {object} deps
 * @param {import('../services/mongo.service').MongoService} deps.mongo
 * @param {import('../services/sql.service').SqlService} deps.sql
 * @param {import('../services/schema.service').SchemaService} deps.schema
 * @param {import('../config/env').config} deps.cfg
 * @param {{ manifestPath?: string|null }} [options]
 * @returns {Promise<{ cancelled?: boolean, results?: object[] }>}
 */
async function runInteractiveCli(deps, options = {}) {
  const { mongo, sql, schema, cfg } = deps;

  if (cfg.migration.dryRun) {
    console.log(
      chalk.yellow.bold(
        '\n⚠  DRY_RUN=true in .env — no CREATE TABLE or inserts will run. Set DRY_RUN=false to load data.\n',
      ),
    );
  }

  const collections = await mongo.listUserCollections();

  let manifestPath = options.manifestPath ?? getManifestPathFromArgv();

  if (!manifestPath) {
    const { jobSource } = await inquirer.prompt([
      {
        type: 'list',
        name: 'jobSource',
        message: 'How should migration jobs be defined?',
        choices: [
          { name: 'Pick collections from MongoDB (interactive)', value: 'mongo' },
          { name: 'Load jobs from a JSON manifest file', value: 'manifest' },
        ],
        default: 'mongo',
      },
    ]);

    if (jobSource === 'manifest') {
      const { pathInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'pathInput',
          message: 'Path to manifest JSON (relative to current folder is OK):',
          validate: (input) => {
            const t = String(input || '').trim();
            if (!t) {
              return 'Enter a file path.';
            }
            try {
              resolveManifestPath(t);
              return true;
            } catch (e) {
              return e.message;
            }
          },
        },
      ]);
      manifestPath = resolveManifestPath(pathInput);
    }
  } else {
    manifestPath = resolveManifestPath(manifestPath);
    console.log(chalk.gray(`Using manifest from argv: ${manifestPath}`));
  }

  /** @type {{ collectionName: string, tableName: string, columns: object[], mode?: string }[]} */
  let jobs;

  if (manifestPath) {
    jobs = await buildJobsFromManifest({
      absManifestPath: manifestPath,
      mongo,
      schema,
      cfg,
      collections,
    });
  } else {
    jobs = await buildJobsFromMongoPicker({
      mongo,
      schema,
      cfg,
      collections,
    });
    if (!jobs.length) {
      console.log(chalk.yellow('Nothing to migrate (all selections were empty or skipped).'));
      return { cancelled: true };
    }

    const { mode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'How should SQL Server tables be handled?',
        choices: [
          { name: 'Overwrite — DROP IF EXISTS, CREATE table, load all rows', value: 'overwrite' },
          { name: 'Append — INSERT into existing table (CREATE only if missing)', value: 'append' },
          { name: 'Skip — do nothing if table already exists', value: 'skip' },
        ],
        default: 'overwrite',
      },
    ]);

    for (const j of jobs) {
      j.mode = mode;
    }
  }

  if (!jobs.length) {
    console.log(chalk.yellow('Nothing to migrate (manifest produced no runnable jobs).'));
    return { cancelled: true };
  }

  console.log(
    chalk.gray(
      `\nTuning: BATCH_SIZE, SCHEMA_SAMPLE_SIZE, MIGRATION_CONCURRENCY, DRY_RUN, LOG_TO_FILE, SQL_PREVIEW → see .env / .env.example\n`,
    ),
  );

  const { proceed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'proceed',
      message: chalk.bold('Start migration to SQL Server now?'),
      default: true,
    },
  ]);

  const logger = new Logger({ logToFile: cfg.migration.logToFile });
  const migration = new MigrationService(mongo, sql, schema, logger);

  try {
    if (!proceed) {
      logger.warn('Migration cancelled by user.');
      return { cancelled: true };
    }

    const spinner = ora({ color: 'cyan' }).start('Connecting to SQL Server…');
    try {
      await sql.connect(cfg.sql);
      spinner.succeed('SQL Server connected.');
    } catch (err) {
      spinner.fail('SQL Server connection failed.');
      throw err;
    }

    logger.info(`Jobs: ${jobs.map((j) => `${j.collectionName}→${j.tableName}(${j.mode})`).join(' | ')}`);

    const results = await migration.migrateMany(jobs, {
      batchSize: cfg.migration.batchSize,
      schemaSampleSize: cfg.migration.schemaSampleSize,
      concurrency: cfg.migration.concurrency,
      dryRun: cfg.migration.dryRun,
      previewSql: cfg.migration.sqlPreview,
    });

    console.log('');
    console.log(chalk.bold.cyan('========== Validation / summary =========='));
    for (const r of results) {
      if (r.skipped) {
        console.log(
          chalk.yellow(
            `${r.collectionName} → ${r.tableName}: SKIPPED | mongo=${r.mongoCount} sql=${r.sqlCount}`,
          ),
        );
        continue;
      }
      if (r.dryRun) {
        console.log(chalk.blue(`${r.collectionName} → ${r.tableName}: DRY RUN | mongo=${r.mongoCount}`));
        continue;
      }
      const ok = r.mongoCount === r.sqlCount;
      const line = `${r.collectionName} → ${r.tableName} | mongo=${r.mongoCount} sql=${r.sqlCount} inserted=${r.inserted} failed=${r.failed} batches=${r.batches} ${ok ? 'MATCH' : 'MISMATCH'} (${r.durationMs} ms)`;
      console.log(ok ? chalk.green(line) : chalk.red(line));
    }
    console.log(chalk.bold.cyan('==========================================\n'));

    const anyMismatch = results.some((r) => !r.skipped && !r.dryRun && r.mongoCount !== r.sqlCount);
    if (anyMismatch) {
      logger.warn('One or more migrations reported a Mongo vs SQL count mismatch.');
    }

    return { results };
  } finally {
    logger.close();
  }
}

module.exports = { runInteractiveCli, defaultSqlTableName, getManifestPathFromArgv };
