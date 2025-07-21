import type { HealthDataDB } from '../db/database';
import type { QueryCache } from '../core/cache';
import type { QueryOptimizer } from '../core/optimizer';
import type { HealthQueryArgs, QueryResult, OutputFormat } from '../types';

export class HealthQueryTool {
  private db: HealthDataDB;
  private cache: QueryCache;
  private optimizer: QueryOptimizer;
  
  constructor(db: HealthDataDB, cache: QueryCache, optimizer: QueryOptimizer) {
    this.db = db;
    this.cache = cache;
    this.optimizer = optimizer;
  }
  
  async execute(args: HealthQueryArgs): Promise<any> {
    const { query, format = 'json' } = args;
    
    // Validate query
    this.validateQuery(query);
    
    // Optimize query
    const optimizedQuery = await this.optimizer.optimizeQuery(query);
    
    // Execute with caching
    const result = await this.cache.getOrExecute(
      optimizedQuery,
      async () => {
        const startTime = Date.now();
        const rows = await this.db.execute(optimizedQuery);
        const executionTime = Date.now() - startTime;
        
        return {
          columns: rows.length > 0 ? Object.keys(rows[0]) : [],
          rows: rows.map(row => Object.values(row)),
          rowCount: rows.length,
          executionTime
        };
      }
    );
    
    // Format result
    return this.formatResult(result, format);
  }
  
  private validateQuery(query: string): void {
    const forbidden = ['drop', 'delete', 'truncate', 'insert', 'update', 'create table', 'alter'];
    const queryLower = query.toLowerCase();
    
    for (const keyword of forbidden) {
      if (queryLower.includes(keyword)) {
        throw new Error(`Query contains forbidden keyword: ${keyword}`);
      }
    }
    
    if (!queryLower.includes('select')) {
      throw new Error('Only SELECT queries are allowed');
    }
  }
  
  private formatResult(result: QueryResult, format: OutputFormat): any {
    switch (format) {
      case 'csv':
        return this.formatAsCSV(result);
      case 'summary':
        return this.formatAsSummary(result);
      case 'json':
      default:
        return {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          executionTime: `${result.executionTime}ms`
        };
    }
  }
  
  private formatAsCSV(result: QueryResult): string {
    const lines: string[] = [];
    
    // Header
    lines.push(result.columns.join(','));
    
    // Rows
    for (const row of result.rows) {
      lines.push(row.map(val => 
        typeof val === 'string' && val.includes(',') 
          ? `"${val}"` 
          : String(val ?? '')
      ).join(','));
    }
    
    return lines.join('\\n');
  }
  
  private formatAsSummary(result: QueryResult): any {
    const summary: any = {
      rowCount: result.rowCount,
      executionTime: `${result.executionTime}ms`,
      columns: result.columns
    };
    
    if (result.rowCount > 0) {
      summary.sampleRows = result.rows.slice(0, 5);
      
      // Add basic statistics for numeric columns
      const numericColumns = result.columns.filter((col, idx) => 
        result.rows.some(row => typeof row[idx] === 'number')
      );
      
      if (numericColumns.length > 0) {
        summary.statistics = {};
        
        for (const col of numericColumns) {
          const colIdx = result.columns.indexOf(col);
          const values = result.rows
            .map(row => row[colIdx])
            .filter(val => typeof val === 'number') as number[];
          
          if (values.length > 0) {
            summary.statistics[col] = {
              min: Math.min(...values),
              max: Math.max(...values),
              avg: values.reduce((a, b) => a + b, 0) / values.length,
              count: values.length
            };
          }
        }
      }
    }
    
    return summary;
  }
}