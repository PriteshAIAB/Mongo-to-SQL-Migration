# MongoDB → SQL Server migrator

Small CLI that reads MongoDB collections (or a JSON manifest), **infers columns** from a sample of documents, **creates** Microsoft SQL Server tables, and **loads** rows in batches using the [`mssql`](https://www.npmjs.com/package/mssql) bulk API.

## Requirements

- Node.js **18+**
- Reachable **MongoDB** and **SQL Server**
- SQL login with `CREATE TABLE`, `DROP TABLE`, and bulk insert rights on the target database

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and set at least:

| Variable | Meaning |
|----------|---------|
| `MONGO_URI` | MongoDB connection string |
| `MONGO_DB` | Database name |
| `SQL_USER` / `SQL_PASSWORD` | SQL Server login |
| `SQL_SERVER` / `SQL_DATABASE` / `SQL_PORT` | SQL Server host, database, port |

Optional flags (see comments in `.env.example`): `BATCH_SIZE`, `SCHEMA_SAMPLE_SIZE`, `MIGRATION_CONCURRENCY`, `DRY_RUN`, `LOG_TO_FILE`, `SQL_ENCRYPT`, `SQL_TRUST_SERVER_CERTIFICATE`, `SQL_PREVIEW`.

## Run

```bash
npm start
```

Follow the prompts to pick collections and table names, or load jobs from a JSON file.

**Manifest (non-interactive job list):**

```bash
node src/index.js --manifest ./src/migrations/manifest.example.json
```

Format: `src/migrations/manifest.example.json`. Unknown collection names are rejected.

## What you get in SQL

- Every table has a **`RID`** column: `BIGINT IDENTITY(1,1)` primary key (same name on every table for joins).
- **`_id`** from Mongo is stored as `VARCHAR(64) NOT NULL UNIQUE` for mapping between tables.
- Nested fields become flat column names like `address_city`; complex values may be stored as JSON text.
- After the run, the CLI prints **Mongo document count vs SQL row count** for each job.

## License

MIT
