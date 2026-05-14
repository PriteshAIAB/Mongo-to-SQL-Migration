# MongoDB → MSSQL migration CLI

A **production-oriented**, **schema-inferred** ETL-style utility that discovers MongoDB collections, samples documents to infer a column layout, creates Microsoft SQL Server tables dynamically, and loads data in **bulk batches** using the `mssql` driver's `Table` bulk API. No GUI tools, no hardcoded collection names, and no online converters.

## Requirements

- **Node.js 18+** (recommended; Node 20+ if you use Azure AD–backed `mssql` features)
- Network access to MongoDB and SQL Server (TCP)
- A SQL login with permission to `CREATE TABLE`, `DROP TABLE`, and `INSERT` (bulk) into the target database

## Quick start

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy `.env.example` to `.env` and fill in connection details:

   | Variable | Purpose |
   |----------|---------|
   | `MONGO_URI` | MongoDB connection string |
   | `MONGO_DB` | MongoDB database name |
   | `SQL_USER` / `SQL_PASSWORD` | SQL authentication |
   | `SQL_SERVER` | Hostname or IP of SQL Server |
   | `SQL_DATABASE` | Target database |
   | `SQL_PORT` | Port (default `1433`) |
   | `SQL_ENCRYPT` | Set to `true` for Azure / encrypted connections |
   | `SQL_TRUST_SERVER_CERTIFICATE` | Default `true` for local dev with self-signed certs; set `false` in hardened production |

   Optional tuning (see `.env.example`):

   - `BATCH_SIZE` — documents per bulk insert (default **1000**)
   - `SCHEMA_SAMPLE_SIZE` — documents scanned for inference (default **100**)
   - `MIGRATION_CONCURRENCY` — parallel collection jobs (default **2**; spinners auto-disable when parallel)
   - `DRY_RUN` — set to `true` only for a **no-op** run (no `CREATE TABLE`, no inserts). Default is **false** so data loads for real.
   - `LOG_TO_FILE` — `true` to append structured lines to `logs/migration-*.log`
   - `SQL_PREVIEW` — `true` (default) to print generated `CREATE TABLE` before each job

3. **Run the interactive CLI**

   ```bash
   npm start
   ```

   **Optional — JSON manifest (no collection picker):**

   ```bash
   node src/index.js --manifest ./path/to/manifest.json
   npm start -- --manifest ./src/migrations/manifest.example.json
   ```

   See `src/migrations/manifest.example.json` for the format. Collection names are **checked against MongoDB**; unknown collection names fail validation. Set `"skipSchemaReview": true` to skip the column-type review (CI / unattended). Per-job **`mode`** can be set on each entry, or set **`defaultMode`** once at the root.

   **Manifest shape (minimal):**

   ```json
   {
     "defaultMode": "overwrite",
     "skipSchemaReview": false,
     "jobs": [
       { "collection": "my_collection", "table": "my_table", "mode": "append" }
     ]
   }
   ```

   Aliases: `collectionName` for `collection`, `tableName` for `table`.

   The tool connects to MongoDB, lists **all user collections** (`listCollections` with `type: 'collection'`), then uses a **short** flow:

   - Choose **MongoDB picker** or **JSON manifest** (or pass `--manifest` / `-m` on the command line)
   - **Mongo path:** select collections, table name per collection, schema table + optional type edits, then **one** overwrite/append/skip choice for all jobs
   - **Manifest path:** jobs and modes come from JSON; same schema sampling + review (unless `skipSchemaReview` is true)
   - Confirm **Start migration** (defaults to **Yes** — real DDL/DML unless `DRY_RUN=true` in `.env`)

   If `DRY_RUN=true` is set in `.env`, a yellow warning is printed at startup; **no table is created and no rows are inserted** until you turn it off.

4. **Validation**

   After each run, the CLI prints a **Mongo `countDocuments` vs SQL `COUNT(*)`** summary. Exit code **2** indicates a count mismatch (partial failures, duplicates, or logic issues).

## Architecture

```text
src/
├── index.js                 # Entry: config, Mongo connect, CLI, cleanup
├── cli/
│   ├── interactive.js       # streamlined inquirer flow
│   ├── manifest.js          # load / validate JSON job manifests
│   └── schemaPrompt.js      # show inferred columns + optional type overrides
├── config/
│   └── env.js                 # dotenv + validation
├── services/
│   ├── mongo.service.js       # connect, listCollections, cursor reads, counts
│   ├── sql.service.js         # pool, DDL, existence checks, bulk insert
│   ├── schema.service.js      # sampling + row shaping
│   ├── migration.service.js   # orchestration, batching, parallel mapLimit
│   └── logger.service.js      # chalk + optional log file
├── utils/
│   ├── flatten.js             # Nested object flattening (e.g. address_city)
│   ├── schemaInference.js     # Column union + type merge
│   ├── mongoTypes.js          # BSON / JS type detection
│   ├── sqlTypes.js            # Logical → MSSQL type mapping
│   ├── objectId.js            # ObjectId helpers
│   └── dateConvert.js         # Date helpers for DATETIME2
├── migrations/
│   └── README.md              # Extension point for versioned / incremental flows
└── logs/                      # Optional migration-*.log files
```

## Behavior highlights

| Topic | Behavior |
|-------|-----------|
| **Discovery** | `db.listCollections({ type: 'collection' })` — no hardcoded names |
| **Schema** | First *N* documents (default 100), flattened keys, merged types |
| **Flattening** | Nested objects → `parent_child`; arrays / odd leaves → JSON in `NVARCHAR(MAX)` |
| **Surrogate PK** | Every table gets a `[<tableName>_srno] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY` injected as the first column — server-assigned unique integer per row |
| **`_id` column** | Pinned to `VARCHAR(64) NOT NULL UNIQUE` — preserves Mongo identity and gives you a fast index for post-migration FK-mapping queries (see "Mapping references" below). 64 chars fits ObjectId hex (24), UUID (36), and short custom string ids. |
| **NOT NULL** | All inferred columns are `NOT NULL`. Missing Mongo values are substituted with type-appropriate **safe defaults** at bulk-insert time (string → `''`, number → `0`, bit → `0`, datetime2 → `1900-01-01`, _id / objectId → `'000000000000000000000000'`) |
| **ObjectId** | Stored as **24-char hex** in `VARCHAR(24)` |
| **Dates** | `DATETIME2` columns; values passed as JavaScript `Date` |
| **Bulk insert** | `mssql` `Table` + `request.bulk()` per batch — not row-by-row `INSERT`. The IDENTITY column is omitted from the bulk payload so SQL Server auto-fills it |
| **Streaming** | Mongo `find` cursor with `batchSize`; SQL bulk per chunk — avoids loading whole collection in RAM |
| **Append mode** | Inserts into an existing table if present. **You** must ensure column compatibility; mismatch may fail at bulk insert time. Prefer `overwrite` for first-time loads. |
| **Parallel** | Multiple jobs run with bounded concurrency; `ora` spinners are suppressed when `jobs > 1` and `concurrency > 1` to avoid garbled output |

### Example generated table

```sql
CREATE TABLE [dbo].[categories] (
  [categories_srno] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  [_id]             VARCHAR(64)   NOT NULL UNIQUE,
  [name]            NVARCHAR(MAX) NOT NULL,
  [parent_id]       NVARCHAR(MAX) NOT NULL,
  [created_at]      DATETIME2     NOT NULL
);
```

If the source documents happen to contain a field that flattens to exactly `<tableName>_srno`, the migrator auto-renames it (e.g. `categories_srno_2`) to keep the IDENTITY column unique.

### Mapping references after migration

The migrator does **not** auto-resolve foreign-key references between collections. Instead, the `_id` columns are preserved as `VARCHAR(24) NOT NULL UNIQUE`, so you can run a single set-based update once all collections have loaded:

```sql
-- 1) Add a resolved-srno column on the child table
ALTER TABLE [dbo].[subcategories] ADD [category_srno] BIGINT NULL;

-- 2) Map subcategories.category_id (the Mongo ObjectId hex) → categories.categories_srno
UPDATE c
SET    c.[category_srno] = p.[categories_srno]
FROM   [dbo].[subcategories] c
LEFT JOIN [dbo].[categories] p
       ON p.[_id] = c.[category_id];

-- 3) Spot orphans (rows whose category_id has no matching parent)
SELECT [_id], [category_id]
FROM   [dbo].[subcategories]
WHERE  [category_id] <> '000000000000000000000000'
  AND  [category_srno] IS NULL;

-- 4) Optionally add a real FK constraint after backfill
ALTER TABLE [dbo].[subcategories]
  ADD CONSTRAINT FK_subcategories_categories
  FOREIGN KEY ([category_srno]) REFERENCES [dbo].[categories]([categories_srno]);
```

## Type mapping (Mongo → SQL)

| Inferred kind | SQL |
|---------------|-----|
| string | `NVARCHAR(MAX)` |
| number | `FLOAT` |
| boolean | `BIT` |
| date | `DATETIME2` |
| ObjectId | `VARCHAR(24)` |
| object / array / binary / unknown | `NVARCHAR(MAX)` (JSON or base64 for `Binary`) |

All inferred columns are created **`NOT NULL`**. Sparse / missing Mongo fields are substituted with type-appropriate safe defaults at bulk-insert time, so the migration never fails on missing fields. If you need to distinguish "missing in Mongo" from "explicitly empty/zero" post-migration, prefer querying the original Mongo source — that information is **not** preserved in SQL after the default substitution.

## Error handling

Connection failures, empty collections, bulk errors, and validation mismatches produce **chalk-colored** messages and optional **file logs**. Failed batches increment a `failed` counter; the run continues where possible so you can inspect partial data.

### `RequestError: Invalid string` (bulk insert)

The SQL Server driver **tedious** requires real JavaScript **strings** for `VARCHAR` / `NVARCHAR` bulk cells. Mongoose-style fields such as `__v` (number) or numeric `sla` / `SCID` values were previously forwarded as numbers when the column was inferred (or overridden) as text, which triggered this error. The migrator now **coerces** every cell to the correct JS type for each column (`src/utils/bulkCoercion.js`) before `request.bulk()`.

## Future extensibility

The layout isolates **dialect-specific** logic in `sql.service.js` and `sqlTypes.js`, and documents extension ideas under `src/migrations/README.md` (PostgreSQL, MySQL, Kafka, CDC, resume tokens, indexes, foreign keys).

## License

MIT
