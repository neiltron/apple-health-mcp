# Apple Health MCP Server

[![npm version](https://badge.fury.io/js/@neiltron%2Fapple-health-mcp.svg)](https://www.npmjs.com/package/@neiltron/apple-health-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Query Apple Health data from an MCP client using SQL and DuckDB. The server runs
locally, reads CSV exports on demand, and provides tools for schema discovery,
read-only queries, and health summaries.

## Requirements

- Node.js 22 or newer
- An Apple Health CSV export created with
  [Simple Health Export CSV](https://apps.apple.com/us/app/simple-health-export-csv/id1535380115)

The native Apple Health `export.xml` format is not currently supported.

## Configure an MCP client

For Claude Desktop, add the following to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-health": {
      "command": "npx",
      "args": ["-y", "@neiltron/apple-health-mcp"],
      "env": {
        "HEALTH_DATA_DIR": "/path/to/your/unzipped/health-export"
      }
    }
  }
}
```

Restart the client after changing its configuration. Other MCP clients can use
the same command, arguments, environment, and `stdio` transport.

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `HEALTH_DATA_DIR` | Yes | — | Directory containing the exported CSV files |
| `MAX_MEMORY_MB` | No | `1024` | DuckDB memory limit in megabytes |
| `CACHE_SIZE` | No | `100` | Maximum number of cached query results |

## Export health data

1. Install and open Simple Health Export CSV on your iPhone.
2. Select **All** and choose the time range to export.
3. Transfer the archive to the computer running your MCP client.
4. Unzip it and set `HEALTH_DATA_DIR` to the resulting directory.

The server reads the files in place. It does not upload the export or make
network requests, although query results returned to your MCP client may be
sent to that client's configured model provider.

## Tools

| Tool | Purpose |
| --- | --- |
| `health_schema` | Discover table names, columns, units, and sample rows |
| `health_query` | Run a read-only `SELECT` query with JSON, CSV, or summary output |
| `health_report` | Generate a weekly, monthly, or custom health summary |

Start with `health_schema`; table names depend on the files in your export.
See [Querying Apple Health data](https://github.com/neiltron/apple-health-mcp/blob/main/docs/querying.md)
for the data model and working examples.

## Current limitation: 90-day window

When a table is first queried, the server currently loads only rows whose
`startDate` is within the last 90 days. This is a hard-coded implementation
limit, not a configurable query default. Older data remains in the CSV files
but is unavailable to tools, and an older export may appear empty. Removing or
making this behavior configurable is planned.

Other current limitations:

- Only the Simple Health Export CSV layout is supported.
- The DuckDB database is in memory and is rebuilt for each server process.
- Device overlap can produce duplicate-looking measurements; queries should
  account for `sourceName` where appropriate.
- Health reports summarize recorded data and are not medical advice.

## Development

```bash
git clone https://github.com/neiltron/apple-health-mcp.git
cd apple-health-mcp
bun install

npm test
npm run typecheck
npm run build
```

See [Architecture](https://github.com/neiltron/apple-health-mcp/blob/main/docs/architecture.md)
for the code layout, data lifecycle, and implementation constraints.

## License

MIT
