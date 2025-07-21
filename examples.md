# Apple Health MCP Server Examples

This document provides practical examples for using the Apple Health MCP Server.

## Setup Example

```bash
# Export your Apple Health data from iPhone:
# 1. Open Health app
# 2. Tap profile icon
# 3. Export All Health Data
# 4. Save and extract the zip file

# Set environment variable
export HEALTH_DATA_DIR="/Users/yourname/Downloads/apple_health_export/HealthAll_2025-07-202_01-04-39_SimpleHealthExportCSV"

# Start the server
bun run src/server.ts
```

## Tool Usage Examples

### 1. Health Query Tool

#### Basic Queries

```javascript
// Get today's heart rate readings
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT * FROM hkquantitytypeidentifierheartrate WHERE DATE(startDate) = CURRENT_DATE ORDER BY startDate DESC"
  }
}

// Average steps per day for the last month
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT DATE(startDate) as date, SUM(value) as total_steps FROM hkquantitytypeidentifierstepcount WHERE startDate >= CURRENT_DATE - INTERVAL '30 days' GROUP BY date ORDER BY date DESC",
    "format": "csv"
  }
}

// Sleep efficiency calculation
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT DATE(startDate) as night, SUM(value)/3600 as hours_asleep, (SUM(CASE WHEN type LIKE '%AsleepDeep%' THEN value ELSE 0 END) * 100.0 / SUM(value)) as deep_sleep_pct FROM hkcategorytypeidentifiersleepanalysis WHERE type LIKE '%Asleep%' GROUP BY night ORDER BY night DESC LIMIT 7",
    "format": "summary"
  }
}
```

#### Advanced Queries

```javascript
// Heart rate variability trends
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT DATE(startDate) as date, AVG(value) as avg_hrv, MIN(value) as min_hrv, MAX(value) as max_hrv, COUNT(*) as measurements FROM hkquantitytypeidentifierheartratevarabilitysdnn WHERE startDate >= CURRENT_DATE - INTERVAL '90 days' GROUP BY date HAVING COUNT(*) > 5 ORDER BY date DESC"
  }
}

// Workout intensity analysis
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT w.activityType, COUNT(DISTINCT DATE(w.startDate)) as workout_days, AVG(w.duration/60) as avg_minutes, AVG(w.totalEnergyBurned) as avg_calories, AVG(hr.value) as avg_heart_rate FROM hkworkoutactivitytype w LEFT JOIN hkquantitytypeidentifierheartrate hr ON hr.startDate BETWEEN w.startDate AND w.endDate WHERE w.startDate >= CURRENT_DATE - INTERVAL '30 days' GROUP BY w.activityType ORDER BY workout_days DESC"
  }
}
```

### 2. Health Insights Tool

```javascript
// Simple questions
{
  "tool": "health_insights",
  "arguments": {
    "question": "How well did I sleep last night?"
  }
}

{
  "tool": "health_insights",
  "arguments": {
    "question": "What's my average heart rate this week?",
    "timeframe": "7 days"
  }
}

// Specific metric analysis
{
  "tool": "health_insights",
  "arguments": {
    "question": "Show me my step count trends",
    "timeframe": "1 month",
    "metrics": ["steps", "distance"]
  }
}

// Comparative questions
{
  "tool": "health_insights",
  "arguments": {
    "question": "How does my activity level compare between last week and this week?",
    "timeframe": "14 days"
  }
}
```

### 3. Health Report Tool

```javascript
// Weekly report
{
  "tool": "health_report",
  "arguments": {
    "report_type": "weekly"
  }
}

// Monthly report with specific metrics
{
  "tool": "health_report",
  "arguments": {
    "report_type": "monthly",
    "include_metrics": ["heart_rate", "sleep", "activity", "workouts"]
  }
}

// Custom date range report
{
  "tool": "health_report",
  "arguments": {
    "report_type": "custom",
    "start_date": "2024-12-01",
    "end_date": "2024-12-31",
    "include_metrics": ["heart_rate", "sleep", "calories", "workouts"]
  }
}
```

## Common Use Cases

### 1. Morning Health Check

```javascript
// Get a quick overview of last night's sleep and today's readiness
{
  "tool": "health_insights",
  "arguments": {
    "question": "How was my sleep last night and what's my resting heart rate this morning?",
    "timeframe": "1 day"
  }
}
```

### 2. Weekly Fitness Review

```javascript
// Comprehensive weekly fitness summary
{
  "tool": "health_report",
  "arguments": {
    "report_type": "weekly",
    "include_metrics": ["workouts", "activity", "calories", "heart_rate"]
  }
}
```

### 3. Training Load Analysis

```javascript
// Analyze training intensity over time
{
  "tool": "health_query",
  "arguments": {
    "query": "WITH weekly_stats AS (SELECT DATE_TRUNC('week', startDate) as week, COUNT(*) as workouts, SUM(duration/3600) as total_hours, AVG(totalEnergyBurned) as avg_calories FROM hkworkoutactivitytype WHERE startDate >= CURRENT_DATE - INTERVAL '12 weeks' GROUP BY week) SELECT week, workouts, ROUND(total_hours, 1) as hours, ROUND(avg_calories, 0) as avg_cal, ROUND(total_hours * 100.0 / LAG(total_hours) OVER (ORDER BY week) - 100, 1) as week_over_week_change FROM weekly_stats ORDER BY week DESC"
  }
}
```

### 4. Recovery Metrics

```javascript
// Check recovery indicators
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT DATE(startDate) as date, AVG(CASE WHEN sourceName LIKE '%Watch%' AND DATE_PART('hour', startDate) BETWEEN 4 AND 10 THEN value END) as morning_hr, AVG(value) as daily_avg_hr, MIN(value) as resting_hr FROM hkquantitytypeidentifierheartrate WHERE startDate >= CURRENT_DATE - INTERVAL '7 days' GROUP BY date ORDER BY date DESC"
  }
}
```

### 5. Sleep Quality Tracking

```javascript
// Detailed sleep analysis
{
  "tool": "health_query",
  "arguments": {
    "query": "WITH sleep_data AS (SELECT DATE(startDate) as night, SUM(CASE WHEN type LIKE '%Awake%' THEN value ELSE 0 END) / 60 as awake_min, SUM(CASE WHEN type LIKE '%AsleepCore%' THEN value ELSE 0 END) / 3600 as core_hr, SUM(CASE WHEN type LIKE '%AsleepDeep%' THEN value ELSE 0 END) / 3600 as deep_hr, SUM(CASE WHEN type LIKE '%AsleepREM%' THEN value ELSE 0 END) / 3600 as rem_hr FROM hkcategorytypeidentifiersleepanalysis WHERE startDate >= CURRENT_DATE - INTERVAL '14 days' GROUP BY night) SELECT *, ROUND((deep_hr + rem_hr) * 100.0 / (core_hr + deep_hr + rem_hr), 1) as quality_sleep_pct FROM sleep_data ORDER BY night DESC",
    "format": "summary"
  }
}
```

## Natural Language Query Patterns

The health_insights tool understands various question patterns:

### Heart Rate Queries
- "What's my heart rate?"
- "Show me heart rate trends"
- "What was my average HR during workouts?"
- "How's my resting heart rate?"

### Sleep Queries
- "How did I sleep?"
- "What's my sleep quality?"
- "Am I getting enough deep sleep?"
- "Show me my sleep patterns"

### Activity Queries
- "How active was I today?"
- "What's my step count?"
- "How many calories did I burn?"
- "Show me my walking distance"

### Workout Queries
- "What workouts did I do?"
- "How long did I exercise?"
- "Which exercises burn the most calories?"
- "Show me my training frequency"

## Performance Tips

1. **Always use date filters** to limit data scanning:
   ```sql
   WHERE startDate >= CURRENT_DATE - INTERVAL '30 days'
   ```

2. **Use aggregations** instead of returning raw data:
   ```sql
   SELECT DATE(startDate), AVG(value) GROUP BY DATE(startDate)
   ```

3. **Limit results** when exploring:
   ```sql
   ORDER BY startDate DESC LIMIT 100
   ```

4. **Use the summary format** for large result sets:
   ```javascript
   { "format": "summary" }
   ```

## Troubleshooting Queries

### Check available data
```javascript
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT DISTINCT type, COUNT(*) as records, MIN(DATE(startDate)) as first_date, MAX(DATE(startDate)) as last_date FROM hkquantitytypeidentifierheartrate GROUP BY type"
  }
}
```

### Verify table names
```javascript
{
  "tool": "health_query",
  "arguments": {
    "query": "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"
  }
}
```