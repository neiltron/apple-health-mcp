# Repository guidance

## Project

This package is a local `stdio` MCP server that queries Simple Health Export
CSV files through an in-memory DuckDB database. The public npm package and MCP
Registry entry are both named in `package.json` and `server.json`.

## Validate changes

Run all three checks before handing off code changes:

```bash
npm test
npm run typecheck
npm run build
```

Tests use Bun. The published runtime requires Node.js 22 or newer.

## Code map

- `src/server.ts`: configuration, MCP tool schemas, dispatch, and stdio startup
- `src/importers/`: per-format ingestion (detection and loading) behind the
  `FormatImporter` interface, plus the single-format registry
- `src/db/`: format-agnostic catalog, lazy table loader, and DuckDB wrapper
- `src/tools/`: implementations of `health_schema`, `health_query`, and
  `health_report`
- `src/core/`: query caching, lazy-load coordination, and memory management
- `server.json`: MCP Registry metadata
- `docs/solutions/`: documented solutions and decisions from past work (bugs,
  tooling choices, patterns), organized by category with YAML frontmatter
  (`module`, `tags`, `problem_type`) — relevant when working in documented areas
- `CONCEPTS.md`: shared domain vocabulary (entities, named processes, status
  concepts) — relevant when orienting to the codebase or discussing domain terms

See `docs/architecture.md` for the runtime flow and `docs/querying.md` for the
normalized data model.

## Invariants

- Never write logs or diagnostics to stdout while the MCP transport is active;
  stdout is reserved for protocol messages.
- Preserve the `health_query` guardrail contract: accept exactly one DuckDB
  SELECT-family analytical statement as classified by DuckDB's parser, then
  reject exact calls to `enable_logging`, `disable_logging`,
  `truncate_duckdb_logs`, `write_log`, and `query` before lazy loading, cache
  lookup, or execution. Keep joins, multiple CTEs, nested/scalar/correlated
  subqueries, `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`, FROM-first syntax,
  `DESCRIBE SELECT`, `SUMMARIZE`, `SHOW`, `TABLE`, and `VALUES` covered by
  acceptance tests; keep top-level mutation/configuration forms and multiple
  statements covered by rejection tests. `query_table` remains supported.
- Do not describe SELECT-family inspection as semantic read-only enforcement or
  as safe handling of attacker-controlled SQL. The supported deployment trusts
  the local `stdio` MCP host/tool caller under the operator's OS account; an
  untrusted bridge, direct caller, or prompt-directed attacker requires process
  or OS isolation.
- Treat DuckDB filesystem, external-access, configuration-lock, memory, and
  no-spill settings as defense in depth, not a sandbox. `allowed_directories`
  permits reads and writes inside `HEALTH_DATA_DIR`.
- Preserve lazy loading unless a deliberate architecture change replaces it.
- Category labels such as sleep stages live in `valueText`; their numeric
  `value` is `NULL`.
- Derive sleep and workout duration from `startDate` and `endDate`; exported
  duration fields are not consistent across formats.
- Workout exports may be one combined file or separate files per activity.
- Never commit personal health exports, databases, logs, or local paths.
- Keep versions synchronized across `package.json`, `server.json` (server and
  package versions), and the MCP implementation version in `src/server.ts`.

## Local planning

`ROADMAP.md` is a local, intentionally uncommitted working plan excluded through
`.git/info/exclude`. Do not add it to commits unless the maintainer explicitly
changes that policy.
