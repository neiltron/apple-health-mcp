# Apple Health Data Analysis Guide

## Overview
This Apple Health export contains 95 CSV files covering various health metrics, activities, and measurements. The data is organized by HealthKit identifiers and includes both quantitative measurements (HKQuantityType) and categorical data (HKCategoryType).

## Data Structure

### Common CSV Fields
Most CSV files share these core fields:
- `type`: The HealthKit identifier
- `sourceName`: Device or app that recorded the data
- `sourceVersion`: Version of the recording source
- `productType`: Hardware model identifier
- `device`: Detailed device information
- `startDate`: UTC timestamp when measurement began
- `endDate`: UTC timestamp when measurement ended
- `unit`: Unit of measurement (varies by metric)
- `value`: The actual measurement value

### Data Categories

#### 1. Vital Signs & Body Metrics
- **Heart Rate** (`HKQuantityTypeIdentifierHeartRate`): BPM measurements with motion context
- **Heart Rate Variability** (`HKQuantityTypeIdentifierHeartRateVariabilitySDNN`): HRV in milliseconds
- **Blood Pressure** (Systolic/Diastolic): Separate files for each measurement
- **Body Mass**: Weight measurements in pounds
- **Respiratory Rate**: Breaths per minute
- **Oxygen Saturation**: SpO2 percentage

#### 2. Activity & Exercise
- **Step Count**: Daily step tracking from Watch and iPhone
- **Active/Basal Energy Burned**: Calories burned (active vs resting)
- **Distance Walking/Running**: Distance metrics in meters
- **Workout Files**: Separate files for each activity type (Cycling, Running, Walking, etc.)
  - Contains duration, total energy burned, distance, and activity-specific metrics

#### 3. Sleep Data
- **Sleep Analysis**: Categorized sleep stages (asleepCore, asleepDeep, asleepREM, inBed)
- Includes timezone information for accurate daily aggregation

#### 4. Nutrition (Dietary)
- 30+ dietary metrics including macros (protein, carbs, fats) and micronutrients
- Most files appear empty in this export

## DuckDB Loading Strategy

### 1. Basic Setup
```sql
-- Install httpfs extension if loading from URLs
INSTALL httpfs;
LOAD httpfs;

-- Create a directory for the data
-- Assuming files are in local directory
SET variable health_data_dir = '/Users/neil/Desktop/RESEARCH/applehealth/HealthAll_2025-07-202_01-04-39_SimpleHealthExportCSV';
```

### 2. Create Base Tables

```sql
-- Heart Rate Data
CREATE TABLE heart_rate AS
SELECT * FROM read_csv('${health_data_dir}/HKQuantityTypeIdentifierHeartRate_*.csv',
    header = true,
    skip = 1,  -- Skip the sep=, line
    timestampformat = '%Y-%m-%d %H:%M:%S +0000'
);

-- Step Count Data
CREATE TABLE step_count AS
SELECT * FROM read_csv('${health_data_dir}/HKQuantityTypeIdentifierStepCount_*.csv',
    header = true,
    skip = 1,
    timestampformat = '%Y-%m-%d %H:%M:%S +0000'
);

-- Sleep Data
CREATE TABLE sleep_analysis AS
SELECT * FROM read_csv('${health_data_dir}/HKCategoryTypeIdentifierSleepAnalysis_*.csv',
    header = true,
    skip = 1,
    timestampformat = '%Y-%m-%d %H:%M:%S +0000'
);

-- Workouts (combine all workout types)
CREATE TABLE workouts AS
SELECT * FROM read_csv('${health_data_dir}/HKWorkoutActivityType*.csv',
    header = true,
    skip = 1,
    timestampformat = '%Y-%m-%d %H:%M:%S +0000',
    union_by_name = true  -- Handle varying columns across workout types
);
```

### 3. Create Optimized Views

```sql
-- Daily Step Summary
CREATE VIEW daily_steps AS
SELECT 
    DATE(startDate) as date,
    SUM(value) as total_steps,
    COUNT(*) as reading_count,
    STRING_AGG(DISTINCT sourceName, ', ') as sources
FROM step_count
GROUP BY DATE(startDate);

-- Heart Rate Stats by Day
CREATE VIEW daily_heart_rate AS
SELECT 
    DATE(startDate) as date,
    AVG(value) as avg_hr,
    MIN(value) as min_hr,
    MAX(value) as max_hr,
    COUNT(*) as reading_count
FROM heart_rate
WHERE value > 30 AND value < 220  -- Filter outliers
GROUP BY DATE(startDate);

-- Sleep Summary
CREATE VIEW sleep_summary AS
SELECT 
    DATE(startDate) as sleep_date,
    SUM(CASE WHEN value = 'inBed' THEN EXTRACT(EPOCH FROM (endDate - startDate))/3600 END) as hours_in_bed,
    SUM(CASE WHEN value IN ('asleepCore', 'asleepDeep', 'asleepREM') 
        THEN EXTRACT(EPOCH FROM (endDate - startDate))/3600 END) as hours_asleep,
    SUM(CASE WHEN value = 'asleepDeep' THEN EXTRACT(EPOCH FROM (endDate - startDate))/3600 END) as hours_deep_sleep,
    SUM(CASE WHEN value = 'asleepREM' THEN EXTRACT(EPOCH FROM (endDate - startDate))/3600 END) as hours_rem_sleep
FROM sleep_analysis
GROUP BY DATE(startDate);
```

## Weekly Check-in Queries

### 1. Weekly Activity Summary
```sql
WITH weekly_data AS (
    SELECT 
        DATE_TRUNC('week', date) as week_start,
        AVG(total_steps) as avg_daily_steps,
        SUM(total_steps) as total_weekly_steps
    FROM daily_steps
    WHERE date >= CURRENT_DATE - INTERVAL '4 weeks'
    GROUP BY DATE_TRUNC('week', date)
)
SELECT 
    week_start,
    avg_daily_steps,
    total_weekly_steps,
    avg_daily_steps - LAG(avg_daily_steps) OVER (ORDER BY week_start) as steps_change
FROM weekly_data
ORDER BY week_start DESC;
```

### 2. Workout Consistency
```sql
SELECT 
    DATE_TRUNC('week', startDate) as week,
    activityType,
    COUNT(*) as workout_count,
    ROUND(SUM(duration)/3600, 1) as total_hours,
    ROUND(SUM(CAST(REGEXP_EXTRACT(totalEnergyBurned, '[\d.]+') AS FLOAT)), 0) as total_calories
FROM workouts
WHERE startDate >= CURRENT_DATE - INTERVAL '4 weeks'
GROUP BY DATE_TRUNC('week', startDate), activityType
ORDER BY week DESC, workout_count DESC;
```

### 3. Sleep Quality Trends
```sql
SELECT 
    DATE_TRUNC('week', sleep_date) as week,
    ROUND(AVG(hours_asleep), 1) as avg_sleep_hours,
    ROUND(AVG(hours_deep_sleep), 1) as avg_deep_sleep,
    ROUND(AVG(hours_asleep / NULLIF(hours_in_bed, 0) * 100), 0) as sleep_efficiency_pct
FROM sleep_summary
WHERE sleep_date >= CURRENT_DATE - INTERVAL '4 weeks'
GROUP BY DATE_TRUNC('week', sleep_date)
ORDER BY week DESC;
```

### 4. Recovery Metrics (Heart Rate)
```sql
-- Resting Heart Rate Trends
SELECT 
    DATE_TRUNC('week', date) as week,
    ROUND(AVG(min_hr), 0) as avg_resting_hr,
    ROUND(AVG(avg_hr), 0) as avg_daily_hr
FROM daily_heart_rate
WHERE date >= CURRENT_DATE - INTERVAL '4 weeks'
GROUP BY DATE_TRUNC('week', date)
ORDER BY week DESC;
```

## LLM Integration Strategies

### 1. Natural Language Queries
Create a prompt template that includes:
- Available tables and their schemas
- Common metric definitions
- Example queries

### 2. Weekly Report Generation
```sql
-- Create a comprehensive view for LLM analysis
CREATE VIEW athlete_weekly_summary AS
SELECT 
    w.week_start,
    s.avg_daily_steps,
    s.total_weekly_steps,
    sl.avg_sleep_hours,
    sl.sleep_efficiency_pct,
    hr.avg_resting_hr,
    wo.total_workout_hours,
    wo.total_workout_calories
FROM (
    SELECT DISTINCT DATE_TRUNC('week', date) as week_start 
    FROM daily_steps 
    WHERE date >= CURRENT_DATE - INTERVAL '4 weeks'
) w
LEFT JOIN (
    -- Steps data
    SELECT DATE_TRUNC('week', date) as week_start,
           AVG(total_steps) as avg_daily_steps,
           SUM(total_steps) as total_weekly_steps
    FROM daily_steps
    GROUP BY DATE_TRUNC('week', date)
) s ON w.week_start = s.week_start
LEFT JOIN (
    -- Sleep data
    SELECT DATE_TRUNC('week', sleep_date) as week_start,
           AVG(hours_asleep) as avg_sleep_hours,
           AVG(hours_asleep / NULLIF(hours_in_bed, 0) * 100) as sleep_efficiency_pct
    FROM sleep_summary
    GROUP BY DATE_TRUNC('week', sleep_date)
) sl ON w.week_start = sl.week_start
LEFT JOIN (
    -- Heart rate data
    SELECT DATE_TRUNC('week', date) as week_start,
           AVG(min_hr) as avg_resting_hr
    FROM daily_heart_rate
    GROUP BY DATE_TRUNC('week', date)
) hr ON w.week_start = hr.week_start
LEFT JOIN (
    -- Workout data
    SELECT DATE_TRUNC('week', startDate) as week_start,
           SUM(duration)/3600 as total_workout_hours,
           SUM(CAST(REGEXP_EXTRACT(totalEnergyBurned, '[\d.]+') AS FLOAT)) as total_workout_calories
    FROM workouts
    GROUP BY DATE_TRUNC('week', startDate)
) wo ON w.week_start = wo.week_start
ORDER BY w.week_start DESC;
```

### 3. LLM Prompt for Weekly Check-ins
```
You are a health coach analyzing an athlete's weekly data. Based on the following metrics:
- Steps: daily average and weekly trends
- Sleep: hours and efficiency
- Heart rate: resting HR trends
- Workouts: frequency, duration, and intensity

Provide:
1. Key observations about their week
2. Progress toward goals
3. Areas of concern
4. Recommendations for the upcoming week
```

## Best Practices

1. **Data Validation**: Always check for outliers and data quality issues
2. **Timezone Handling**: Convert UTC timestamps to local time for daily aggregations
3. **Device Deduplication**: Multiple devices may record the same activity
4. **Performance**: Create indexes on frequently queried date columns
5. **Privacy**: Ensure data handling complies with privacy requirements

## Next Steps

1. Set up automated data ingestion pipeline
2. Create athlete-specific dashboards
3. Implement anomaly detection for health metrics
4. Build predictive models for performance optimization
5. Integrate with training plan adjustments based on recovery metrics