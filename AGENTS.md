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

See `docs/architecture.md` for the runtime flow and `docs/querying.md` for the
normalized data model.

## Invariants

- Never write logs or diagnostics to stdout while the MCP transport is active;
  stdout is reserved for protocol messages.
- Keep `health_query` read-only. Any change to query validation needs tests for
  accepted `SELECT` statements and rejected mutation statements.
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
