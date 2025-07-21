import type { HealthDataDB } from '../db/database';
import type { QueryCache } from '../core/cache';
import type { HealthReportArgs } from '../types';

interface ReportSection {
  title: string;
  data: any;
  summary: string;
}

export class HealthReportTool {
  private db: HealthDataDB;
  private cache: QueryCache;
  
  constructor(db: HealthDataDB, cache: QueryCache) {
    this.db = db;
    this.cache = cache;
  }
  
  async execute(args: HealthReportArgs): Promise<any> {
    const { report_type, start_date, end_date, include_metrics } = args;
    
    // Determine date range
    const dateRange = this.getDateRange(report_type, start_date, end_date);
    
    // Determine which metrics to include
    const metrics = include_metrics || this.getDefaultMetrics();
    
    // Generate report sections
    const sections: ReportSection[] = [];
    
    for (const metric of metrics) {
      try {
        const section = await this.generateSection(metric, dateRange);
        if (section) sections.push(section);
      } catch (error) {
        console.error(`Failed to generate ${metric} section:`, error);
      }
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
  ): { start: string; end: string } {
    const now = new Date();
    
    switch (type) {
      case 'weekly':
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - 7);
        return {
          start: weekStart.toISOString().split('T')[0],
          end: now.toISOString().split('T')[0]
        };
        
      case 'monthly':
        const monthStart = new Date(now);
        monthStart.setDate(now.getDate() - 30);
        return {
          start: monthStart.toISOString().split('T')[0],
          end: now.toISOString().split('T')[0]
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
    
    const data = result.rows[0];
    const [avgHr, minHr, maxHr, readings, days] = data || [0, 0, 0, 0, 0];
    
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
    
    const data = result.rows[0];
    const [avgSteps, totalSteps, activeDays] = data || [0, 0, 0];
    
    return {
      title: 'Activity',
      data: {
        averageDailySteps: avgSteps,
        totalSteps: totalSteps,
        activeDays: activeDays
      },
      summary: `Average ${avgSteps.toLocaleString()} steps/day (${totalSteps.toLocaleString()} total)`
    };
  }
  
  private async generateSleepSection(
    dateRange: { start: string; end: string }
  ): Promise<ReportSection> {
    const query = `
      SELECT 
        ROUND(AVG(total_hours), 1) as avg_sleep_hours,
        ROUND(MIN(total_hours), 1) as min_sleep_hours,
        ROUND(MAX(total_hours), 1) as max_sleep_hours,
        COUNT(*) as nights_tracked
      FROM (
        SELECT 
          DATE(startDate) as night,
          SUM(value) / 3600 as total_hours
        FROM hkcategorytypeidentifiersleepanalysis
        WHERE type LIKE '%Asleep%'
          AND DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
        GROUP BY DATE(startDate)
      )
    `;
    
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
    
    const data = result.rows[0];
    const [avgSleep, minSleep, maxSleep, nights] = data || [0, 0, 0, 0];
    
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
    const query = `
      SELECT 
        COUNT(*) as total_workouts,
        COUNT(DISTINCT activityType) as workout_types,
        ROUND(SUM(duration) / 3600, 1) as total_hours,
        ROUND(SUM(totalEnergyBurned), 0) as total_calories
      FROM hkworkoutactivitytype
      WHERE DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
    `;
    
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
    
    const data = result.rows[0];
    const [workouts, types, hours, calories] = data || [0, 0, 0, 0];
    
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
    const query = `
      SELECT 
        ROUND(AVG(active_cal), 0) as avg_active_calories,
        ROUND(AVG(basal_cal), 0) as avg_basal_calories,
        ROUND(AVG(active_cal + basal_cal), 0) as avg_total_calories
      FROM (
        SELECT 
          DATE(startDate) as date,
          SUM(CASE WHEN type LIKE '%ActiveEnergyBurned%' THEN value ELSE 0 END) as active_cal,
          SUM(CASE WHEN type LIKE '%BasalEnergyBurned%' THEN value ELSE 0 END) as basal_cal
        FROM (
          SELECT * FROM hkquantitytypeidentifieractiveenergyburned
          WHERE DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
          UNION ALL
          SELECT * FROM hkquantitytypeidentifierbasalenergyburned
          WHERE DATE(startDate) BETWEEN '${dateRange.start}' AND '${dateRange.end}'
        )
        GROUP BY DATE(startDate)
      )
    `;
    
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
    
    const data = result.rows[0];
    const [avgActive, avgBasal, avgTotal] = data || [0, 0, 0];
    
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
    const start = new Date(dateRange.start).toLocaleDateString();
    const end = new Date(dateRange.end).toLocaleDateString();
    
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
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }
  
  private generateOverallSummary(sections: ReportSection[]): string {
    const summaries = sections.map(s => s.summary).filter(s => s);
    return summaries.join('. ');
  }
}