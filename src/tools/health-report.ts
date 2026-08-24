import type { HealthDataDB } from '../db/database';
import type { QueryCache } from '../core/cache';
import type { FileCatalog } from '../db/catalog';
import type { TableLoader } from '../db/loader';
import type { HealthReportArgs } from '../types';

interface ReportSection {
  title: string;
  data: any;
  summary: string;
}

interface DateRange {
  start: string;
  end: string;
}

export class HealthReportTool {
  private db: HealthDataDB;
  private cache: QueryCache;
  private catalog: FileCatalog;
  private loader: TableLoader;

  constructor(db: HealthDataDB, cache: QueryCache, catalog: FileCatalog, loader: TableLoader) {
    this.db = db;
    this.cache = cache;
    this.catalog = catalog;
    this.loader = loader;
  }

  async execute(args: HealthReportArgs): Promise<any> {
    const { report_type, start_date, end_date, include_metrics } = args;

    // Determine date range
    const dateRange = this.getDateRange(report_type, start_date, end_date);

    // Determine which metrics to include
    const metrics = include_metrics || this.getDefaultMetrics();

    // Generate report sections
    const sections: ReportSection[] = [];

    // A load or query failure stops the report so the MCP server returns a tool
    // error. Absent metrics are reported as missing sections, not as failures.
    for (const metric of metrics) {
      const section = await this.generateSection(metric, dateRange);
      if (section) sections.push(section);
    }

    // Create final report
    return {
      title: this.getReportTitle(report_type, dateRange),
      period: {
        start: dateRange.start,
        end: dateRange.end,
        days: this.daysBetween(dateRange.start, dateRange.end)
      },
      generatedAt: new Date().toISOString(),
      sections,
      summary: this.generateOverallSummary(sections)
    };
  }

  private getDateRange(
    type: 'weekly' | 'monthly' | 'custom',
    startDate?: string,
    endDate?: string
  ): DateRange {
    const now = new Date();

    switch (type) {
      case 'weekly':
        const weekStart = new Date(now);
        const weekEnd = new Date(now);
        weekStart.setDate(now.getDate() - 7);
        weekEnd.setDate(now.getDate() - 1);
        return {
          start: weekStart.toISOString().split('T')[0],
          end: weekEnd.toISOString().split('T')[0]
        };

      case 'monthly':
        const monthStart = new Date(now);
        const monthEnd = new Date(now);
        monthStart.setDate(now.getDate() - 30);
        monthEnd.setDate(now.getDate() - 1);
        return {
          start: monthStart.toISOString().split('T')[0],
          end: monthEnd.toISOString().split('T')[0]
        };

      case 'custom':
        if (!startDate || !endDate) {
          throw new Error('Start and end dates required for custom reports');
        }
        return { start: startDate, end: endDate };
    }
  }

  private getDefaultMetrics(): string[] {
    return [
      'heart_rate',
      'activity',
      'sleep',
      'workouts',
      'calories'
    ];
  }

  // Tables load on demand, so a report on a cold server has to load what it
  // needs before querying. A table the export does not contain is an absent
  // metric, but a load failure is a real error and stops the report.
  private async ensureTables(tableNames: string[]): Promise<string[]> {
    const loaded: string[] = [];

    for (const tableName of tableNames) {
      if (!this.catalog.getEntry(tableName)) continue;

      await this.loader.ensureTableLoaded(tableName);
      loaded.push(tableName);
    }

    return loaded;
  }

  private getWorkoutTables(): string[] {
    return this.catalog.getTablesByKind('workout');
  }

  private missingSection(title: string, metricLabel: string): ReportSection {
    return {
      title,
      data: {},
      summary: `No ${metricLabel} data available`
    };
  }

  private async runQuery(query: string): Promise<any[]> {
    const result = await this.cache.getOrExecute(
      query,
      async () => {
        const rows = await this.db.execute(query);
        return {
          columns: Object.keys(rows[0] || {}),
          rows: rows.map(row => Object.values(row)),
          rowCount: rows.length,
          executionTime: 0
        };
      }
    );

    return result.rows[0] || [];
  }

  private async generateSection(
    metric: string,
    dateRange: { start: string; end: string }
  ): Promise<ReportSection | null> {
    switch (metric) {
      case 'heart_rate':
        return await this.generateHeartRateSection(dateRange);
      case 'activity':
        return await this.generateActivitySection(dateRange);
      case 'sleep':
        return await this.generateSleepSection(dateRange);
      case 'workouts':
        return await this.generateWorkoutSection(dateRange);
      case 'calories':
        return await this.generateCaloriesSection(dateRange);
      default:
        return null;
    }
  }

  private async generateHeartRateSection(
    dateRange: { start: string; end: string }
  ): Promise<ReportSection> {
    const tables = await this.ensureTables(['hkquantitytypeidentifierheartrate']);
    if (tables.length === 0) {
      return this.missingSection('Heart Rate', 'heart rate');
    }

    const query = `
      SELECT
        ROUND(AVG(value), 1) as avg_hr,
        ROUND(MIN(value), 1) as min_hr,
        ROUND(MAX(value), 1) as max_hr,
        COUNT(*) as total_readings,
        COUNT(DISTINCT DATE(startDate)) as days_with_data
      FROM hkquantitytypeidentifierheartrate
      WHERE DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
    `;

    const data = await this.runQuery(query);
    const [avgHr, minHr, maxHr, readings, days] = data.length ? data : [0, 0, 0, 0, 0];
    if (Number(readings) === 0) {
      return this.missingSection('Heart Rate', 'heart rate');
    }

    return {
      title: 'Heart Rate',
      data: {
        average: avgHr,
        minimum: minHr,
        maximum: maxHr,
        totalReadings: readings,
        daysWithData: days
      },
      summary: `Average heart rate: ${avgHr} bpm (${minHr}-${maxHr} bpm) across ${days} days`
    };
  }

  private async generateActivitySection(
    dateRange: { start: string; end: string }
  ): Promise<ReportSection> {
    const tables = await this.ensureTables(['hkquantitytypeidentifierstepcount']);
    if (tables.length === 0) {
      return this.missingSection('Activity', 'activity');
    }

    const query = `
      SELECT
        ROUND(AVG(daily_steps), 0) as avg_daily_steps,
        ROUND(SUM(daily_steps), 0) as total_steps,
        COUNT(*) as active_days
      FROM (
        SELECT
          DATE(startDate) as date,
          SUM(value) as daily_steps
        FROM hkquantitytypeidentifierstepcount
        WHERE DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
        GROUP BY DATE(startDate)
      )
    `;

    const data = await this.runQuery(query);
    const [avgSteps, totalSteps, activeDays] = data.length ? data : [0, 0, 0];
    if (Number(activeDays) === 0) {
      return this.missingSection('Activity', 'activity');
    }

    return {
      title: 'Activity',
      data: {
        averageDailySteps: avgSteps,
        totalSteps: totalSteps,
        activeDays: activeDays
      },
      summary: `Average ${Number(avgSteps ?? 0).toLocaleString()} steps/day (${Number(totalSteps ?? 0).toLocaleString()} total)`
    };
  }

  private async generateSleepSection(
    dateRange: { start: string; end: string }
  ): Promise<ReportSection> {
    const tables = await this.ensureTables(['hkcategorytypeidentifiersleepanalysis']);
    if (tables.length === 0) {
      return this.missingSection('Sleep', 'sleep');
    }

    // The stage lives in the value label, not in type, and the duration has to
    // come from the timestamps - a category value is a label, not seconds.
    // Matching '%asleep%' covers both HKCategoryValueSleepAnalysisAsleepCore and
    // the bare asleepCore style, and excludes InBed and Awake rows.
    const query = `
      SELECT
        ROUND(AVG(total_hours), 1) as avg_sleep_hours,
        ROUND(MIN(total_hours), 1) as min_sleep_hours,
        ROUND(MAX(total_hours), 1) as max_sleep_hours,
        COUNT(*) as nights_tracked
      FROM (
        SELECT
          DATE(startDate) as night,
          SUM(DATE_DIFF('second', startDate, endDate)) / 3600.0 as total_hours
        FROM hkcategorytypeidentifiersleepanalysis
        WHERE LOWER(valueText) LIKE '%asleep%'
          AND DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
        GROUP BY DATE(startDate)
      )
    `;

    const data = await this.runQuery(query);
    const [avgSleep, minSleep, maxSleep, nights] = data.length ? data : [0, 0, 0, 0];
    if (Number(nights) === 0) {
      return this.missingSection('Sleep', 'sleep');
    }

    return {
      title: 'Sleep',
      data: {
        averageHours: avgSleep,
        minimumHours: minSleep,
        maximumHours: maxSleep,
        nightsTracked: nights
      },
      summary: `Average ${avgSleep} hours/night across ${nights} nights`
    };
  }

  private async generateWorkoutSection(
    dateRange: { start: string; end: string }
  ): Promise<ReportSection> {
    // Workouts may be exported as one table or as one table per activity type.
    const tables = await this.ensureTables(this.getWorkoutTables());
    if (tables.length === 0) {
      return this.missingSection('Workouts', 'workouts');
    }

    const selects: string[] = [];
    for (const table of tables) {
      const columns = await this.db.execute(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = '${table}'
      `);
      const columnNames = new Set(
        columns.map((col: any) => String(col.column_name).toLowerCase())
      );

      let typeExpr = `'${table}'`;
      if (columnNames.has('type')) {
        typeExpr = `COALESCE(type, ${typeExpr})`;
      }
      if (columnNames.has('activitytype')) {
        typeExpr = `COALESCE(activityType, ${typeExpr})`;
      }
      const energyExpr = columnNames.has('totalenergyburned')
        ? 'TRY_CAST(totalEnergyBurned AS DOUBLE)'
        : 'NULL';

      // Duration comes from the timestamps. The exported duration column is
      // minutes in some formats and seconds in others, so it cannot be trusted.
      selects.push(`
        SELECT
          ${typeExpr} as workout_type,
          DATE_DIFF('second', startDate, endDate) as duration_seconds,
          ${energyExpr} as energy
        FROM ${table}
        WHERE DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
      `);
    }

    const query = `
      SELECT
        COUNT(*) as total_workouts,
        COUNT(DISTINCT workout_type) as workout_types,
        ROUND(SUM(duration_seconds) / 3600.0, 1) as total_hours,
        ROUND(SUM(energy), 0) as total_calories
      FROM (${selects.join('\n        UNION ALL\n')})
    `;

    const data = await this.runQuery(query);
    const [workouts, types, hours, calories] = data.length ? data : [0, 0, 0, null];
    if (Number(workouts) === 0) {
      return this.missingSection('Workouts', 'workouts');
    }

    return {
      title: 'Workouts',
      data: {
        totalWorkouts: workouts,
        workoutTypes: types,
        totalHours: hours,
        totalCalories: calories
      },
      summary: `${workouts} workouts (${types} types) totaling ${hours} hours`
    };
  }

  private async generateCaloriesSection(
    dateRange: { start: string; end: string }
  ): Promise<ReportSection> {
    const tables = await this.ensureTables([
      'hkquantitytypeidentifieractiveenergyburned',
      'hkquantitytypeidentifierbasalenergyburned'
    ]);
    if (tables.length === 0) {
      return this.missingSection('Calories', 'calories');
    }

    const sources = tables.map(table => `
          SELECT type, startDate, value FROM ${table}
          WHERE DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
    `);

    const query = `
      SELECT
        ROUND(AVG(active_cal), 0) as avg_active_calories,
        ROUND(AVG(basal_cal), 0) as avg_basal_calories,
        ROUND(AVG(active_cal + basal_cal), 0) as avg_total_calories,
        COUNT(*) as days_tracked
      FROM (
        SELECT
          DATE(startDate) as date,
          SUM(CASE WHEN type LIKE '%ActiveEnergyBurned%' THEN value ELSE 0 END) as active_cal,
          SUM(CASE WHEN type LIKE '%BasalEnergyBurned%' THEN value ELSE 0 END) as basal_cal
        FROM (${sources.join('\n          UNION ALL\n')})
        GROUP BY DATE(startDate)
      )
    `;

    const data = await this.runQuery(query);
    const [avgActive, avgBasal, avgTotal, daysTracked] = data.length ? data : [0, 0, 0, 0];
    if (Number(daysTracked) === 0) {
      return this.missingSection('Calories', 'calories');
    }

    return {
      title: 'Calories',
      data: {
        averageActiveCalories: avgActive,
        averageBasalCalories: avgBasal,
        averageTotalCalories: avgTotal
      },
      summary: `Average ${avgTotal} calories/day (${avgActive} active + ${avgBasal} basal)`
    };
  }

  private getReportTitle(
    type: 'weekly' | 'monthly' | 'custom',
    dateRange: { start: string; end: string }
  ): string {
    // Date-only strings parse at UTC midnight. Format them in UTC as well so
    // local time zones west of Greenwich do not display the previous day.
    const dateFormatOptions: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
    const start = new Date(dateRange.start).toLocaleDateString(undefined, dateFormatOptions);
    const end = new Date(dateRange.end).toLocaleDateString(undefined, dateFormatOptions);

    switch (type) {
      case 'weekly':
        return `Weekly Health Report (${start} - ${end})`;
      case 'monthly':
        return `Monthly Health Report (${start} - ${end})`;
      case 'custom':
        return `Health Report (${start} - ${end})`;
    }
  }

  private daysBetween(start: string, end: string): number {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
    return Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
  }

  private generateOverallSummary(sections: ReportSection[]): string {
    const summaries = sections.map(s => s.summary).filter(s => s);
    return summaries.join('. ');
  }
}
