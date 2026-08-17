# Architecture

Apple Health MCP is a local, tools-only MCP server over `stdio`. It catalogs a
directory of Simple Health Export CSV files and loads only the tables needed by
each request into an in-memory DuckDB database.

## Runtime flow

1. `src/server.ts` reads `HEALTH_DATA_DIR`, `MAX_MEMORY_MB`, and `CACHE_SIZE`.
2. `HealthDataDB` creates an in-memory DuckDB database and applies its memory
   limit.
3. `FileCatalog` scans the export directory and maps recognized filenames to
   lowercase table names. It does not load CSV contents during startup.
4. An MCP request is dispatched to `health_schema`, `health_query`, or
   `health_report`.
5. `TableLoader` loads the required CSVs into DuckDB, normalizes important
   columns, and adds indexes for dates and metric types.
6. Results are cached in memory and returned through the MCP transport.

The process owns one DuckDB database. Nothing is persisted between launches.

## Components

### Catalog and lazy loading

`src/db/catalog.ts` recognizes quantity, category, and workout CSV filenames.
Filename suffixes such as export dates are removed from the table name.
`src/db/loader.ts` finds catalog table names mentioned in a SQL query and
materializes those tables before execution (`ensureTablesForQuery`).

The name detection is intentionally simple substring matching, not a SQL
parser. A query can only trigger loading for a table already known to the
catalog.

### Normalization

`src/db/loader.ts` performs these transformations:

- `startDate` and `endDate` become DuckDB timestamps.
- A quantity row's `value` becomes a number.
- A category row's label is retained as `valueText`; its numeric `value` is
  `NULL`.
- Columns specific to workout exports are retained as supplied.

Sleep and workout durations should be calculated from the timestamps. Duration
columns vary between export formats and are not treated as authoritative.

### Query safety and caching

`health_query` requires a statement containing `SELECT` and rejects a small
blocklist of mutation keywords. This is a pragmatic guard, not a complete SQL
parser or security boundary.

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
into the typed final table. `TableLoader` sniffs the file's columns with
`DESCRIBE` first, which samples rather than materializes, so the projection
matches the quantity, category, or workout shape it was given. Staging raw
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

- Simple Health Export CSV is the only ingest format.
- The database is in memory and is rebuilt per process; incremental or
  persistent import is planned future work.
- Query validation and lazy-load table detection are string-based.
- The implementation exposes tools only—no resources, prompts, HTTP transport,
  or hosted service.
