# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
This is an Apple Health data analysis project that processes health data exported from the Apple Health app. The project focuses on analyzing personal health metrics and building infrastructure for natural language health insights.

## Data Structure
The repository contains 95 CSV files exported from Apple Health in the `HealthAll_2025-07-202_01-04-39_SimpleHealthExportCSV/` directory:
- **HKCategoryTypeIdentifier*.csv**: Categorical health data (sleep stages, mindful sessions)
- **HKQuantityTypeIdentifier*.csv**: Quantitative metrics (heart rate, steps, calories, etc.)
- **HKWorkoutActivityType*.csv**: Workout and activity data by type

### CSV Format
All files follow this structure:
- Header: `sep=,`
- Common columns: type, sourceName, sourceVersion, productType, device, startDate, endDate, unit, value
- Timestamps in UTC: `YYYY-MM-DD HH:MM:SS +0000`

## Architecture & Implementation

### MCP Server Design
The project includes plans for an MCP (Model Context Protocol) server with:
- **DuckDB** as the analytics engine for efficient CSV processing
- **Lazy loading** with file-level granularity
- **Three main tools**:
  - `health_query`: Direct SQL queries against health data
  - `health_insights`: Natural language analysis
  - `health_report`: Generate formatted reports

### Key Technical Decisions
1. Use DuckDB's native CSV reading capabilities for performance
2. Implement connection pooling for concurrent access
3. Cache parsed data in memory with TTL
4. Support incremental data loading for large datasets

## Common Analysis Tasks

### Loading Data into DuckDB
```sql
-- Create database and load CSV files
CREATE TABLE heart_rate AS 
SELECT * FROM read_csv_auto('HealthAll*/HKQuantityTypeIdentifierHeartRate.csv');

-- Convert timestamps
UPDATE heart_rate 
SET startDate = strptime(startDate, '%Y-%m-%d %H:%M:%S +0000');
```

### Example Queries
```sql
-- Daily heart rate summary
SELECT DATE(startDate) as date,
       AVG(value) as avg_hr,
       MIN(value) as min_hr,
       MAX(value) as max_hr
FROM heart_rate
GROUP BY DATE(startDate)
ORDER BY date DESC;

-- Sleep efficiency calculation
SELECT DATE(startDate) as night,
       SUM(CASE WHEN type LIKE '%AsleepCore%' THEN value ELSE 0 END) as core_sleep,
       SUM(CASE WHEN type LIKE '%AsleepDeep%' THEN value ELSE 0 END) as deep_sleep,
       SUM(CASE WHEN type LIKE '%AsleepREM%' THEN value ELSE 0 END) as rem_sleep
FROM sleep_analysis
GROUP BY DATE(startDate);
```

## Important Health Metrics
When analyzing data, prioritize these key metrics:
1. **Recovery**: HRV, resting heart rate, sleep quality
2. **Activity**: Steps, active calories, workout duration/intensity
3. **Vitals**: Heart rate zones, blood pressure, respiratory rate
4. **Sleep**: Total duration, sleep stages distribution, consistency

## Data Quality Considerations
- Many nutrition-related CSV files may be empty
- Multiple devices (Apple Watch, iPhone) may record duplicate data
- Always validate timezone conversions for accurate daily summaries
- Check for data gaps when calculating trends

## Future Development Focus
- Implement automated data ingestion pipeline
- Build athlete-specific performance dashboards
- Create anomaly detection for health metrics
- Develop predictive models for training optimization
- Enable natural language queries via LLM integration