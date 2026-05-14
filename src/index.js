#!/usr/bin/env node

/**
 * Entry point: loads configuration, connects data stores, runs interactive CLI.
 * Structured for future sinks (PostgreSQL, MySQL, Kafka, CDC, scheduling, resume, indexes, FKs).
 */

const chalk = require('chalk');
const ora = require('ora');
const { config } = require('./config/env');
const { MongoService } = require('./services/mongo.service');
const { SqlService } = require('./services/sql.service');
const { SchemaService } = require('./services/schema.service');
const { runInteractiveCli } = require('./cli/interactive');

async function main() {
  console.log(chalk.bold.green('\nMongoDB → MSSQL migration utility\n'));

  const mongo = new MongoService();
  const sql = new SqlService();
  const schema = new SchemaService();

  const connectSpinner = ora({ color: 'yellow' }).start('Connecting to MongoDB...');
  try {
    await mongo.connect(config.mongo.uri, config.mongo.database);
    connectSpinner.succeed(`MongoDB connected (database: ${config.mongo.database}).`);
  } catch (err) {
    connectSpinner.fail('MongoDB connection failed.');
    console.error(chalk.red(err.message || err));
    process.exitCode = 1;
    return;
  }

  try {
    const cliResult = await runInteractiveCli({
      mongo,
      sql,
      schema,
      cfg: config,
    });

    if (cliResult && cliResult.cancelled) {
      process.exitCode = 0;
      return;
    }

    if (cliResult && cliResult.results) {
      const anyMismatch = cliResult.results.some(
        (r) => !r.skipped && !r.dryRun && r.mongoCount !== r.sqlCount,
      );
      if (anyMismatch) {
        process.exitCode = 2;
      }
    }
  } catch (err) {
    console.error(chalk.red('Migration failed:'), err.message || err);
    if (err.stack) {
      console.error(chalk.gray(err.stack));
    }
    process.exitCode = 1;
  } finally {
    await mongo.disconnect().catch(() => {});
    await sql.close().catch(() => {});
  }
}

main();
