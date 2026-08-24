# Architecture

Apple Health MCP is a local, tools-only MCP server over `stdio`. It catalogs a
directory of Simple Health Export CSV files and loads only the tables needed by
each request into an in-memory DuckDB database.

## Runtime flow

1. `src/server.ts` reads `HEALTH_DATA_DIR`, `MAX_MEMORY_MB`, and `CACHE_SIZE`.
2. `HealthDataDB` creates an in-memory DuckDB database and applies its memory
   limit.
3. `FileCatalog` scans the export directory through the importer registry:
   each format importer's `detect` claims its files and maps them to canonical
   lowercase table names with a table kind. No data is loaded during startup.
4. An MCP request is dispatched to `health_schema`, `health_query`, or
   `health_report`.
5. `TableLoader` asks each required table's importer to materialize it into
   DuckDB — normalizing important columns and adding indexes for dates and
   metric types — and records the loaded state.
6. Results are cached in memory and returned through the MCP transport.

The process owns one DuckDB database. Nothing is persisted between launches.

## Components

### Format importers

`src/importers/` holds all ingestion-path format knowledge, one directory per
format. A `FormatImporter` carries a stable id and display name and exposes
two operations: `detect` scans the data directory and returns the tables the
format can produce (canonical lowercase names plus a table kind) without
materializing anything, and `load` materializes one table into DuckDB,
returning its row count. `src/importers/simple-csv/` is the only importer
today and owns the filename regexes and the CSV dialect. Filename suffixes
such as export dates are removed from the table name during detection.

The registry enforces one format per data directory. When two importers claim
files in the same scan, the catalog records a typed conflict — surfaced
through `health_schema` with the fix (split the directories) — and keeps its
previous state rather than picking a winner.

### Catalog and lazy loading

`src/db/catalog.ts` is format-agnostic: it delegates scanning to the importer
registry and owns table lifecycle state (loaded, row count, last access).
Scans commit atomically, and entries whose files disappear are retained.
Kinds assigned at detection are the only source of table classification —
`health_report` and `health_schema` select workout tables by kind, never by
name pattern.

`src/db/loader.ts` finds catalog table names mentioned in a SQL query and
materializes those tables before execution (`ensureTablesForQuery`).

The name detection is intentionally simple substring matching, not a SQL
parser. A query can only trigger loading for a table already known to the
catalog.

### Normalization

The simple-csv importer's `load` performs these transformations:

- `startDate` and `endDate` become DuckDB timestamps.
- A quantity row's `value` becomes a number.
- A category row's label is retained as `valueText`; its numeric `value` is
  `NULL`.
- Columns specific to workout exports are retained as supplied.

Sleep and workout durations should be calculated from the timestamps. Duration
columns vary between export formats and are not treated as authoritative.

The conformance suite in `src/test-helpers/conformance.ts` asserts this
contract end-to-end for every importer; a new format adopts it by supplying
fixtures.

### Query boundary

`health_query` is confined by two independent layers.

The engine sandbox is the enforcement of record. At startup `setupDatabase`
sets `allowed_directories` to `HEALTH_DATA_DIR`, then `enable_external_access =
false`, then `lock_configuration = true`. File access is therefore limited to
the data directory — the loader's `read_csv` on catalog files keeps working,
while `read_text('/etc/hosts')`, out-of-directory `COPY`, `ATTACH`, and
extension *installation* (`INSTALL`, which needs external access) fail at
execution — and no later query can loosen any of these settings, including
re-enabling disk spill. Loading an already-bundled extension (`LOAD`) is not
blocked at the engine; the validator layer stops it because `LOAD` is not a
`SELECT`. This holds even when a query
hides a file read inside a macro or a form the tool never parses: the engine
stops the access at runtime regardless.

The validator adds the one thing the engine leaves open. Since the data
directory is writable, `COPY (SELECT ...) TO` a file *inside* it would succeed
at the engine. `health_query` rejects it by asking DuckDB's own parser
(`json_serialize_sql`) whether the input is exactly one read-only `SELECT`
statement; anything else — non-`SELECT` forms, multiple statements — is
rejected before execution. Because the parser decides statement kind and count,
a query of any internal complexity (joins, CTEs, nested subqueries, `UNION`) is
accepted, and a string literal or column name containing a word like `drop` or
`reset` is no longer a false positive.

These settings are defense-in-depth for a local single-user stdio server, not
OS-level process sandboxing; DuckDB's own guidance is explicit that engine
settings are not a substitute for sandboxing untrusted SQL at the process
level. One known limitation: `allowed_directories` does not canonicalize paths,
so a symlink placed *inside* the data directory pointing outside it can be
read. Reaching this requires an attacker who can write a symlink into the data
directory, which is outside the query-sending threat model this boundary
targets.

Query results use an in-memory bounded cache. Aggregate queries receive a
ten-minute TTL. For non-aggregate queries, requests involving `CURRENT_DATE` or
`NOW()` receive one minute and other requests receive five minutes.

### Memory management

DuckDB receives the configured memory limit, which defaults to 2048MB and is
overridden by `MAX_MEMORY_MB`. A two-year multi-table export holds roughly
1 GiB resident, so the default leaves headroom for loading full history.

`max_temp_directory_size` is set to `0 bytes`. DuckDB therefore cannot spill to
a temporary directory, which keeps health rows out of files on disk and turns an
over-capacity load into an explicit error instead of silent disk use.

A periodic manager also estimates loaded-table memory from row counts and evicts
least-recently-used tables under pressure. This estimate is approximate.

## History loading

A table's first request loads its full CSV history. There is no date window, so
the rows a query can reach are limited only by the export itself. A row is
excluded only when its `startDate` cannot be cast to a timestamp, or when the
file shape has a `value` column and that value is null.

The load is a single pass: one `CREATE TABLE AS SELECT` reads the CSV straight
into the typed final table. The simple-csv importer sniffs the file's columns
with `DESCRIBE` first, which samples rather than materializes, so the
projection matches the quantity, category, or workout shape it was given. Staging raw
VARCHAR rows in a separate table beforehand would hold two copies resident and
roughly double peak memory for a large export.

A failed load drops the partially created table and raises. The failure
propagates to the calling tool rather than leaving an empty table that looks
like an export with no data.

## Transport constraints

The server uses MCP over process stdin/stdout. stdout must contain protocol
messages only; diagnostics belong on stderr. The server itself performs no
remote calls and does not upload health data, but returned results pass to the
MCP client and are subject to that client's data handling.

## Current boundaries

- Simple Health Export CSV is the only registered ingest format; the importer
  interface exists so Apple Health XML and Health Auto Export can be added
  without touching the catalog or loader.
- One export format per data directory.
- The database is in memory and is rebuilt per process; incremental or
  persistent import is planned future work.
- Query validation uses DuckDB's parser (single read-only `SELECT`); lazy-load
  table detection is still string-based.
- The implementation exposes tools only—no resources, prompts, HTTP transport,
  or hosted service.
