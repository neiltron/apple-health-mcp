# Apple Health MCP Server

[![npm version](https://badge.fury.io/js/@neiltron%2Fapple-health-mcp.svg)](https://badge.fury.io/js/@neiltron%2Fapple-health-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP (Model Context Protocol) server for querying Apple Health data using SQL. Built with DuckDB for fast, efficient health data analysis.

> [!NOTE]  
> This project currently relies on the [Simple Health Export CSV](https://apps.apple.com/us/app/simple-health-export-csv/id1535380115?itsct=apps_box_badge&itscg=30200) app by [Eric Wolter](https://www.ericwolter.com). See [Exporting Data](#exporting-data) below for more info on how best to use the app.
>
> This is currently the easiest way I could find to quickly and reliably get Apple Health data exported in CSV format. If you have ideas of better ways to import data, please submit an issue.


## Features
- **Natural language querying**: Your MCP client translates your questions to database queries
- **SQL Query Execution**: Direct SQL queries against your Apple Health data
- **Automated Reports**: Generate weekly/monthly health summaries
- **Efficient Data Loading**: Lazy loading with configurable time windows
- **Smart Caching**: Query result caching with TTL

## Installation

No installation required! Use directly with npx via Claude Desktop or other MCP clients.

## Usage with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "apple-health": {
      "command": "npx",
      "args": ["@neiltron/apple-health-mcp"],
      "env": {
        "HEALTH_DATA_DIR": "/path/to/your/health/export"
      }
    }
  }
}
```

### Environment Variables

- `HEALTH_DATA_DIR` (required): Path to your Apple Health CSV export directory
- `MAX_MEMORY_MB` (optional): Maximum memory usage in MB (default: 1024)
- `CACHE_SIZE` (optional): Number of cached query results (default: 100)

### Example Configuration

```json
{
  "mcpServers": {
    "apple-health": {
      "command": "npx",
      "args": ["@neiltron/apple-health-mcp"],
      "env": {
        "HEALTH_DATA_DIR": "/Users/yourname/Downloads/HealthAll_2025-07-202_01-04-39_SimpleHealthExportCSV",
        "MAX_MEMORY_MB": "2048"
      }
    }
  }
}
```

### Exporting Data
To use get your data:
- Download the [Simple Health Export CSV](https://apps.apple.com/us/app/simple-health-export-csv/id1535380115?itsct=apps_box_badge&itscg=30200) app for iOS. 
- Tap the `All` button in the app to download all data for your desired time range (default 1 month).
- When prompted, Airdrop it to your computer or transfer it some other way.
- Unzip the file to your desired location
- Set the `HEALTH_DATA_DIR` value in your MCP config. See [Example Configuration](#example-configuration) above.

## Available Tools

1. `health_query`: Execute SQL queries directly on your health data.
2. `health_report`: Generate comprehensive health reports.

## Data Structure

The server expects Apple Health data exported as CSV files with the following naming pattern:
- `HKQuantityTypeIdentifier*.csv` - Quantitative health metrics
- `HKCategoryTypeIdentifier*.csv` - Categorical health data
- `HKWorkoutActivityType*.csv` - Workout and activity data

Each CSV file should have these columns:
- `type`: The specific health metric type
- `sourceName`: Source device/app
- `startDate`: Start timestamp (UTC)
- `endDate`: End timestamp (UTC)
- `value`: The measurement value
- `unit`: Unit of measurement

## Development

For local development:

```bash
# Clone and install dependencies
git clone https://github.com/neiltron/apple-health-mcp.git
cd apple-health-mcp
npm install

# Build the project
npm run build

# Type checking
npm run typecheck
```

## Troubleshooting

### Common Issues

1. **"No data found"**: Check that your CSV files are in the correct directory
2. **Memory errors**: Reduce `MAX_MEMORY_MB` or use shorter time windows
3. **Slow queries**: Ensure you're filtering by date ranges
4. **Missing tables**: Table names are lowercase (e.g., `hkquantitytypeidentifierheartrate`)


## Contributing

Contributions are welcome! Please ensure:
- Code follows existing patterns
- TypeScript types are properly defined
- Error handling is comprehensive
- Performance impact is considered

## License

MIT