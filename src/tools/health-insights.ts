import type { HealthDataDB } from '../db/database';
import type { QueryCache } from '../core/cache';
import type { QueryOptimizer } from '../core/optimizer';
import type { HealthInsightsArgs } from '../types';

interface QueryTemplate {
  pattern: RegExp;
  template: string;
  params: string[];
}

export class HealthInsightsTool {
  private db: HealthDataDB;
  private cache: QueryCache;
  private optimizer: QueryOptimizer;
  private templates: QueryTemplate[];
  
  constructor(db: HealthDataDB, cache: QueryCache, optimizer: QueryOptimizer) {
    this.db = db;
    this.cache = cache;
    this.optimizer = optimizer;
    this.templates = this.initializeTemplates();
  }
  
  private initializeTemplates(): QueryTemplate[] {
    return [
      {
        pattern: /heart rate|hr|pulse/i,
        template: `
          SELECT 
            DATE(startDate) as date,
            ROUND(AVG(value), 1) as avg_heart_rate,
            ROUND(MIN(value), 1) as min_heart_rate,
            ROUND(MAX(value), 1) as max_heart_rate,
            COUNT(*) as readings
          FROM hkquantitytypeidentifierheartrate
          WHERE startDate >= CURRENT_DATE - INTERVAL '{timeframe}'
          GROUP BY DATE(startDate)
          ORDER BY date DESC
          LIMIT 30
        `,
        params: ['timeframe']
      },
      {
        pattern: /sleep|rest|recovery/i,
        template: `
          SELECT 
            DATE(startDate) as night,
            ROUND(SUM(CASE WHEN type LIKE '%AsleepCore%' THEN value ELSE 0 END) / 3600, 1) as core_hours,
            ROUND(SUM(CASE WHEN type LIKE '%AsleepDeep%' THEN value ELSE 0 END) / 3600, 1) as deep_hours,
            ROUND(SUM(CASE WHEN type LIKE '%AsleepREM%' THEN value ELSE 0 END) / 3600, 1) as rem_hours,
            ROUND(SUM(value) / 3600, 1) as total_hours
          FROM hkcategorytypeidentifiersleepanalysis
          WHERE type LIKE '%Asleep%'
            AND startDate >= CURRENT_DATE - INTERVAL '{timeframe}'
          GROUP BY DATE(startDate)
          ORDER BY night DESC
          LIMIT 30
        `,
        params: ['timeframe']
      },
      {
        pattern: /steps|walking|activity/i,
        template: `
          SELECT 
            DATE(startDate) as date,
            ROUND(SUM(value), 0) as total_steps,
            ROUND(AVG(value), 0) as avg_steps_per_reading,
            COUNT(*) as readings
          FROM hkquantitytypeidentifierstepcount
          WHERE startDate >= CURRENT_DATE - INTERVAL '{timeframe}'
          GROUP BY DATE(startDate)
          ORDER BY date DESC
          LIMIT 30
        `,
        params: ['timeframe']
      },
      {
        pattern: /workout|exercise|training/i,
        template: `
          SELECT 
            activityType,
            COUNT(*) as sessions,
            ROUND(SUM(duration) / 3600, 1) as total_hours,
            ROUND(AVG(duration) / 60, 0) as avg_minutes,
            ROUND(SUM(totalEnergyBurned), 0) as total_calories
          FROM hkworkoutactivitytype
          WHERE startDate >= CURRENT_DATE - INTERVAL '{timeframe}'
          GROUP BY activityType
          ORDER BY sessions DESC
          LIMIT 20
        `,
        params: ['timeframe']
      },
      {
        pattern: /calorie|energy|burn/i,
        template: `
          SELECT 
            DATE(startDate) as date,
            ROUND(SUM(CASE WHEN type LIKE '%ActiveEnergyBurned%' THEN value ELSE 0 END), 0) as active_calories,
            ROUND(SUM(CASE WHEN type LIKE '%BasalEnergyBurned%' THEN value ELSE 0 END), 0) as basal_calories,
            ROUND(SUM(value), 0) as total_calories
          FROM (
            SELECT * FROM hkquantitytypeidentifieractiveenergyburned
            UNION ALL
            SELECT * FROM hkquantitytypeidentifierbasalenergyburned
          )
          WHERE startDate >= CURRENT_DATE - INTERVAL '{timeframe}'
          GROUP BY DATE(startDate)
          ORDER BY date DESC
          LIMIT 30
        `,
        params: ['timeframe']
      }
    ];
  }
  
  async execute(args: HealthInsightsArgs): Promise<any> {
    const { question, timeframe = '30 days', metrics } = args;
    
    try {
      // Try to match with templates first
      const sql = await this.generateSQL(question, timeframe, metrics);
      
      // Optimize and execute
      const optimizedQuery = await this.optimizer.optimizeQuery(sql);
      const result = await this.cache.getOrExecute(
        optimizedQuery,
        async () => {
          const rows = await this.db.execute(optimizedQuery);
          return {
            columns: rows.length > 0 ? Object.keys(rows[0]) : [],
            rows: rows.map(row => Object.values(row)),
            rowCount: rows.length,
            executionTime: 0
          };
        },
        { question, timeframe }
      );
      
      // Generate insights
      return this.generateInsights(question, result);
    } catch (error) {
      return {
        error: `Failed to generate insights: ${error}`,
        suggestion: 'Try rephrasing your question or use the health_query tool directly'
      };
    }
  }
  
  private async generateSQL(question: string, timeframe: string, metrics?: string[]): Promise<string> {
    // Try to match with templates
    for (const template of this.templates) {
      if (template.pattern.test(question)) {
        let sql = template.template;
        
        // Replace parameters
        sql = sql.replace('{timeframe}', this.parseTimeframe(timeframe));
        
        // Add metric filters if specified
        if (metrics && metrics.length > 0) {
          // This would need more sophisticated handling in a real implementation
        }
        
        return sql.trim();
      }
    }
    
    // If no template matches, generate a basic query
    return this.generateBasicQuery(question, timeframe);
  }
  
  private parseTimeframe(timeframe: string): string {
    const match = timeframe.match(/(\d+)\s*(day|week|month|year)s?/i);
    if (match) {
      return `${match[1]} ${match[2]}`;
    }
    return '30 days';
  }
  
  private generateBasicQuery(question: string, timeframe: string): string {
    // This is a simplified fallback - in production, you'd use an LLM
    return `
      SELECT 
        type,
        DATE(startDate) as date,
        AVG(value) as avg_value,
        COUNT(*) as count
      FROM hkquantitytypeidentifierheartrate
      WHERE startDate >= CURRENT_DATE - INTERVAL '${this.parseTimeframe(timeframe)}'
      GROUP BY type, DATE(startDate)
      ORDER BY date DESC
      LIMIT 100
    `;
  }
  
  private generateInsights(question: string, result: any): any {
    const insights: any = {
      question,
      summary: '',
      data: result.rows.slice(0, 10),
      columns: result.columns,
      totalRows: result.rowCount
    };
    
    // Generate summary based on the data
    if (result.rowCount === 0) {
      insights.summary = 'No data found for the specified timeframe.';
    } else {
      // Analyze the data pattern
      if (question.toLowerCase().includes('heart rate')) {
        insights.summary = this.generateHeartRateInsights(result);
      } else if (question.toLowerCase().includes('sleep')) {
        insights.summary = this.generateSleepInsights(result);
      } else if (question.toLowerCase().includes('steps')) {
        insights.summary = this.generateActivityInsights(result);
      } else {
        insights.summary = `Found ${result.rowCount} records matching your query.`;
      }
    }
    
    // Add trends if applicable
    if (result.rowCount > 7) {
      insights.trend = this.calculateTrend(result);
    }
    
    return insights;
  }
  
  private generateHeartRateInsights(result: any): string {
    const avgIdx = result.columns.indexOf('avg_heart_rate');
    if (avgIdx === -1) return 'Heart rate data analyzed.';
    
    const values = result.rows.map(row => row[avgIdx]).filter(v => v != null);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    return `Average heart rate over the period: ${avg.toFixed(1)} bpm (range: ${min}-${max} bpm)`;
  }
  
  private generateSleepInsights(result: any): string {
    const totalIdx = result.columns.indexOf('total_hours');
    if (totalIdx === -1) return 'Sleep data analyzed.';
    
    const values = result.rows.map(row => row[totalIdx]).filter(v => v != null);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    
    return `Average sleep duration: ${avg.toFixed(1)} hours per night`;
  }
  
  private generateActivityInsights(result: any): string {
    const stepsIdx = result.columns.indexOf('total_steps');
    if (stepsIdx === -1) return 'Activity data analyzed.';
    
    const values = result.rows.map(row => row[stepsIdx]).filter(v => v != null);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const total = values.reduce((a, b) => a + b, 0);
    
    return `Average daily steps: ${Math.round(avg).toLocaleString()} (total: ${Math.round(total).toLocaleString()})`;
  }
  
  private calculateTrend(result: any): string {
    // Simple trend calculation - compare first and last week
    if (result.rowCount < 14) return 'Insufficient data for trend analysis';
    
    const valueIdx = result.columns.findIndex(col => 
      col.includes('avg') || col.includes('total') || col === 'value'
    );
    
    if (valueIdx === -1) return 'No numeric data for trend analysis';
    
    const firstWeek = result.rows.slice(0, 7).map(row => row[valueIdx]);
    const lastWeek = result.rows.slice(-7).map(row => row[valueIdx]);
    
    const avgFirst = firstWeek.reduce((a, b) => a + b, 0) / firstWeek.length;
    const avgLast = lastWeek.reduce((a, b) => a + b, 0) / lastWeek.length;
    
    const change = ((avgLast - avgFirst) / avgFirst) * 100;
    
    if (Math.abs(change) < 5) return 'Stable';
    return change > 0 ? `Increasing (${change.toFixed(1)}%)` : `Decreasing (${change.toFixed(1)}%)`;
  }
}