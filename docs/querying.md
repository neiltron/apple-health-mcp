# Querying Apple Health data

Apple Health MCP exposes export files as lowercase DuckDB table names. Because
the exact files vary by export, call `health_schema` before writing SQL.

## Data model

Recognized filenames map to tables such as:

| Export file prefix | Example table |
| --- | --- |
| `HKQuantityTypeIdentifierHeartRate` | `hkquantitytypeidentifierheartrate` |
| `HKQuantityTypeIdentifierStepCount` | `hkquantitytypeidentifierstepcount` |
| `HKCategoryTypeIdentifierSleepAnalysis` | `hkcategorytypeidentifiersleepanalysis` |
| `HKWorkoutActivityTypeRunning` | `hkworkoutactivitytyperunning` |

Export-date suffixes are removed. Workout exports may produce one combined
table or separate tables for different activities.

Common normalized columns are:

- `startDate`, `endDate`: DuckDB timestamps
- `sourceName`: device or app that recorded the row
- `unit`: measurement unit when present
- `value`: numeric value for quantity measurements
- `valueText`: original label for category measurements

Always inspect `unit` before combining measurements. Multiple devices can also
record overlapping rows, so naïve sums may overcount some metrics.

## Quantity examples

Daily heart-rate statistics:

```sql
SELECT
  DATE(startDate) AS date,
  ROUND(AVG(value), 1) AS average_bpm,
  ROUND(MIN(value), 1) AS minimum_bpm,
  ROUND(MAX(value), 1) AS maximum_bpm,
  COUNT(*) AS readings
FROM hkquantitytypeidentifierheartrate
WHERE startDate >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY DATE(startDate)
ORDER BY date DESC;
```

Daily step totals, separated by source and unit so possible overlap remains
visible:

```sql
SELECT
  DATE(startDate) AS date,
  sourceName,
  unit,
  SUM(value) AS steps
FROM hkquantitytypeidentifierstepcount
WHERE startDate >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(startDate), sourceName, unit
ORDER BY date DESC, sourceName;
```

## Category and sleep examples

Category labels are stored in `valueText`, not the numeric `value` column.
Calculate durations from the timestamps:

```sql
SELECT
  DATE(startDate) AS night,
  valueText AS stage,
  ROUND(SUM(DATE_DIFF('second', startDate, endDate)) / 3600.0, 2) AS hours
FROM hkcategorytypeidentifiersleepanalysis
WHERE startDate >= CURRENT_DATE - INTERVAL '14 days'
GROUP BY DATE(startDate), valueText
ORDER BY night DESC, stage;
```

Total asleep time excludes awake and in-bed rows by matching asleep labels:

```sql
SELECT
  DATE(startDate) AS night,
  ROUND(SUM(DATE_DIFF('second', startDate, endDate)) / 3600.0, 2) AS hours_asleep
FROM hkcategorytypeidentifiersleepanalysis
WHERE LOWER(valueText) LIKE '%asleep%'
  AND startDate >= CURRENT_DATE - INTERVAL '14 days'
GROUP BY DATE(startDate)
ORDER BY night DESC;
```

## Workouts

Use the `commonPatterns.workouts` list returned by `health_schema` to discover
the workout tables in a particular export. Workout duration should be computed
as:

```sql
DATE_DIFF('second', startDate, endDate) / 60.0
```

The `health_report` tool already aggregates across every discovered workout
table and is usually the easiest way to request a weekly or monthly overview.

## Tool arguments

`health_query` accepts:

```json
{
  "query": "SELECT ...",
  "format": "json"
}
```

`format` can be `json`, `csv`, or `summary`. Only read-only `SELECT` queries are
accepted.

`health_report` accepts `weekly`, `monthly`, or `custom` reports. Custom reports
require `start_date` and `end_date` in `YYYY-MM-DD` form. Optional
`include_metrics` values are `heart_rate`, `activity`, `sleep`, `workouts`, and
`calories`.

## Current data window

Only records from the last 90 days are loaded at present, even if the CSV files
contain older history. This is a server limitation rather than a SQL filter;
removing a date predicate from a query does not expose older rows. The behavior
is under review.
