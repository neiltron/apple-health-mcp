import type { TableLoader } from '../db/loader';
import type { FileCatalog } from '../db/catalog';

export class QueryOptimizer {
  private loader: TableLoader;
  private catalog: FileCatalog;
  private viewDefinitions: Map<string, string> = new Map();
  
  constructor(loader: TableLoader, catalog: FileCatalog) {
    this.loader = loader;
    this.catalog = catalog;
    this.initializeViews();
  }
  
  private initializeViews(): void {
    // Common aggregate views
    this.viewDefinitions.set('daily_heart_rate', `
      SELECT 
        DATE(startDate) as date,
        AVG(value) as avg_hr,
        MIN(value) as min_hr,
        MAX(value) as max_hr,
        COUNT(*) as readings
      FROM hkquantitytypeidentifierheartrate
      GROUP BY DATE(startDate)
    `);
    
    this.viewDefinitions.set('weekly_activity', `
      SELECT 
        DATE_TRUNC('week', startDate) as week_start,
        SUM(CASE WHEN type LIKE '%StepCount%' THEN value ELSE 0 END) as total_steps,
        SUM(CASE WHEN type LIKE '%ActiveEnergyBurned%' THEN value ELSE 0 END) as active_calories,
        SUM(CASE WHEN type LIKE '%DistanceWalkingRunning%' THEN value ELSE 0 END) as distance_km
      FROM (
        SELECT * FROM hkquantitytypeidentifierstepcount
        UNION ALL
        SELECT * FROM hkquantitytypeidentifieractiveenergyburned
        UNION ALL
        SELECT * FROM hkquantitytypeidentifierdistancewalkingrunning
      )
      GROUP BY DATE_TRUNC('week', startDate)
    `);
    
    this.viewDefinitions.set('sleep_summary', `
      SELECT 
        DATE(startDate) as sleep_date,
        SUM(CASE WHEN type LIKE '%AsleepCore%' THEN value ELSE 0 END) / 3600 as core_hours,
        SUM(CASE WHEN type LIKE '%AsleepDeep%' THEN value ELSE 0 END) / 3600 as deep_hours,
        SUM(CASE WHEN type LIKE '%AsleepREM%' THEN value ELSE 0 END) / 3600 as rem_hours,
        SUM(value) / 3600 as total_hours
      FROM hkcategorytypeidentifiersleepanalysis
      WHERE type LIKE '%Asleep%'
      GROUP BY DATE(startDate)
    `);
  }
  
  async optimizeQuery(query: string): Promise<string> {
    // Extract required tables
    const requiredTables = this.loader.extractTableNames(query);
    
    // Ensure tables are loaded
    await Promise.all(
      requiredTables.map(table => this.loader.ensureTableLoaded(table))
    );
    
    // Try to substitute with materialized views
    let optimized = query;
    for (const [viewName, viewDef] of this.viewDefinitions) {
      if (query.toLowerCase().includes(viewName)) {
        optimized = optimized.replace(
          new RegExp(viewName, 'gi'),
          `(${viewDef})`
        );
      }
    }
    
    return optimized;
  }
  
  async analyzeQuery(query: string): Promise<{
    requiredTables: string[];
    estimatedRows: number;
    usesCaching: boolean;
    optimizations: string[];
  }> {
    const requiredTables = this.loader.extractTableNames(query);
    const optimizations: string[] = [];
    
    // Check for missing indexes
    if (query.toLowerCase().includes('where') && 
        !query.toLowerCase().includes('startdate')) {
      optimizations.push('Consider filtering by startDate for better performance');
    }
    
    // Check for full table scans
    if (!query.toLowerCase().includes('limit') && 
        !query.toLowerCase().includes('group by')) {
      optimizations.push('Consider adding LIMIT to avoid loading all rows');
    }
    
    // Estimate row count
    let estimatedRows = 0;
    for (const table of requiredTables) {
      const entry = this.catalog.getEntry(table);
      if (entry?.rowCount) {
        estimatedRows += entry.rowCount;
      }
    }
    
    return {
      requiredTables,
      estimatedRows,
      usesCaching: estimatedRows < 10000,
      optimizations
    };
  }
  
  generateExplainPlan(query: string): string {
    return `EXPLAIN ANALYZE ${query}`;
  }
  
  suggestIndexes(tableName: string): string[] {
    const suggestions: string[] = [];
    
    // Always suggest date index
    suggestions.push(
      `CREATE INDEX idx_${tableName}_dates ON ${tableName}(startDate, endDate)`
    );
    
    // Suggest type index for category tables
    if (tableName.includes('category')) {
      suggestions.push(
        `CREATE INDEX idx_${tableName}_type ON ${tableName}(type)`
      );
    }
    
    // Suggest value index for quantity tables
    if (tableName.includes('quantity')) {
      suggestions.push(
        `CREATE INDEX idx_${tableName}_value ON ${tableName}(value) WHERE value IS NOT NULL`
      );
    }
    
    return suggestions;
  }
}