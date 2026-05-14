# Migrations (extension point)

This folder is reserved for future **versioned migration scripts**, **checkpoint metadata**, or **resume tokens** when incremental / CDC-style workflows are added.

The current CLI performs **ad hoc, schema-inferred** loads per run.

**JSON manifests:** put repeatable job lists in a file (see `manifest.example.json` in this folder). Run with `node src/index.js --manifest ./src/migrations/your-manifest.json` or choose “Load jobs from a JSON manifest file” at startup. Jobs are validated against **live** MongoDB collection names.

Planned extension hooks (see service interfaces in `src/services/`):

- Dialect-specific DDL modules (PostgreSQL, MySQL)
- Richer manifest features (upsert keys, watermarks, CDC)
- Idempotent upsert keys and watermark columns for incremental sync
