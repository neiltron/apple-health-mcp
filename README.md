# Apple Health MCP Server

An MCP (Model Context Protocol) server for querying Apple Health data using natural language and SQL. Built with Bun and DuckDB for fast, efficient health data analysis.

## Features

- **SQL Query Execution**: Direct SQL queries against your Apple Health data
- **Natural Language Insights**: Ask questions in plain English
- **Automated Reports**: Generate weekly/monthly health summaries
- **Efficient Data Loading**: Lazy loading with configurable time windows
- **Smart Caching**: Query result caching with TTL
- **Memory Management**: Automatic table eviction under memory pressure

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd apple-health-mcp

# Install dependencies
bun install
```

## Usage

### Starting the Server

```bash
# Set the path to your Apple Health export directory
export HEALTH_DATA_DIR="/path/to/HealthAll_2025-07-202_01-04-39_SimpleHealthExportCSV"

# Run the server
bun run src/server.ts

# Or with custom settings
HEALTH_DATA_DIR=/path/to/data MAX_MEMORY_MB=2048 bun run src/server.ts
```

### Environment Variables

- `HEALTH_DATA_DIR` (required): Path to your Apple Health CSV export directory
- `MAX_MEMORY_MB` (optional): Maximum memory usage in MB (default: 1024)
- `CACHE_SIZE` (optional): Number of cached query results (default: 100)

### Using with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "apple-health": {
      "command": "bun",
      "args": ["run", "/path/to/apple-health-mcp/src/server.ts"],
      "env": {
        "HEALTH_DATA_DIR": "/path/to/your/health/export"
      }
    }
  }
}
```

## Available Tools

### 1. health_query

Execute SQL queries directly on your health data.

```javascript
// Example usage
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT DATE(startDate) as date, AVG(value) as avg_hr FROM hkquantitytypeidentifierheartrate WHERE startDate > '2024-01-01' GROUP BY date",
    "format": "json"  // or "csv", "summary"
  }
}
```

### 2. health_insights

Get insights using natural language questions.

```javascript
// Example usage
{
  "tool": "health_insights",
  "arguments": {
    "question": "What was my average heart rate last week?",
    "timeframe": "7 days"
  }
}
```

### 3. health_report

Generate comprehensive health reports.

```javascript
// Example usage
{
  "tool": "health_report",
  "arguments": {
    "report_type": "weekly",  // or "monthly", "custom"
    "include_metrics": ["heart_rate", "sleep", "activity"]
  }
}
```

## Example Queries

### SQL Examples

```sql
-- Daily step count
SELECT DATE(startDate) as date, SUM(value) as steps
FROM hkquantitytypeidentifierstepcount
WHERE startDate >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY date
ORDER BY date DESC;

-- Sleep analysis
SELECT 
  DATE(startDate) as night,
  SUM(CASE WHEN type LIKE '%AsleepCore%' THEN value ELSE 0 END) / 3600 as core_hours,
  SUM(CASE WHEN type LIKE '%AsleepDeep%' THEN value ELSE 0 END) / 3600 as deep_hours,
  SUM(CASE WHEN type LIKE '%AsleepREM%' THEN value ELSE 0 END) / 3600 as rem_hours
FROM hkcategorytypeidentifiersleepanalysis
WHERE type LIKE '%Asleep%'
GROUP BY DATE(startDate)
ORDER BY night DESC
LIMIT 7;

-- Heart rate zones during workouts
SELECT 
  activityType,
  AVG(hr.value) as avg_hr,
  MIN(hr.value) as min_hr,
  MAX(hr.value) as max_hr
FROM hkworkoutactivitytype w
JOIN hkquantitytypeidentifierheartrate hr
  ON hr.startDate BETWEEN w.startDate AND w.endDate
GROUP BY activityType;
```

### Natural Language Examples

- "What was my average sleep duration last month?"
- "Show me my heart rate trends over the past week"
- "How many steps did I take yesterday?"
- "What were my most active days this week?"
- "Compare my sleep quality between weekdays and weekends"

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

## Performance Considerations

- **Lazy Loading**: Tables are loaded only when queried
- **Time Windows**: By default, only loads last 90 days of data
- **Caching**: Query results cached for 5-10 minutes
- **Memory Management**: Automatic table eviction when memory exceeds 80% of limit
- **Indexes**: Automatic creation of date and type indexes

## Development

```bash
# Run in development mode with auto-reload
bun run dev

# Type checking
bun run typecheck
```

## Architecture

- **Database Layer**: DuckDB in-memory database for fast analytics
- **Catalog System**: Automatic discovery and tracking of CSV files
- **Lazy Loader**: On-demand table loading with configurable time windows
- **Cache Layer**: SHA256-based query result caching
- **Memory Manager**: LRU eviction and memory pressure monitoring
- **Query Optimizer**: Template matching and query rewriting
- **MCP Tools**: Three specialized tools for different use cases

## Troubleshooting

### Common Issues

1. **"No data found"**: Check that your CSV files are in the correct directory
2. **Memory errors**: Reduce `MAX_MEMORY_MB` or use shorter time windows
3. **Slow queries**: Ensure you're filtering by date ranges
4. **Missing tables**: Table names are lowercase (e.g., `hkquantitytypeidentifierheartrate`)

### Debug Mode

Set `DEBUG=true` to enable verbose logging:

```bash
DEBUG=true HEALTH_DATA_DIR=/path/to/data bun run src/server.ts
```

## Contributing

Contributions are welcome! Please ensure:
- Code follows existing patterns
- TypeScript types are properly defined
- Error handling is comprehensive
- Performance impact is considered

## License

MIT