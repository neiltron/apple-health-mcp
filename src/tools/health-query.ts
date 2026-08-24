import type { HealthDataDB } from '../db/database';
import type { QueryCache } from '../core/cache';
import type { TableLoader } from '../db/loader';
import type { HealthQueryArgs, QueryResult, OutputFormat } from '../types';

function isFiniteNumber(value: any): value is number {
  return Number.isFinite(value);
}

export class HealthQueryTool {
  private db: HealthDataDB;
  private cache: QueryCache;
  private loader: TableLoader;

  constructor(db: HealthDataDB, cache: QueryCache, loader: TableLoader) {
    this.db = db;
    this.cache = cache;
    this.loader = loader;
  }

  async execute(args: HealthQueryArgs): Promise<any> {
    const { query, format = 'json' } = args;

    // Validate query
    this.validateQuery(query);

    await this.loader.ensureTablesForQuery(query);

    // Execute with caching
    const result = await this.cache.getOrExecute(
      query,
      async () => {
        const startTime = Date.now();
        const rows = await this.db.execute(query);
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

    // Configuration statements could re-enable disk spill or change limits the
    // server set at startup. Word boundaries keep OFFSET and column names legal.
    const configStatement = /\b(set|reset|pragma)\b/i.exec(query);
    if (configStatement) {
      throw new Error(`Query contains forbidden keyword: ${configStatement[1].toLowerCase()}`);
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
      lines.push(row.map(val => {
        const text = String(val ?? '');
        return text.includes(',') ? `"${text}"` : text;
      }).join(','));
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
        result.rows.some(row => isFiniteNumber(row[idx]))
      );
      
      if (numericColumns.length > 0) {
        summary.statistics = {};
        
        for (const col of numericColumns) {
          const colIdx = result.columns.indexOf(col);
          const values = result.rows
            .map(row => row[colIdx])
            .filter(isFiniteNumber);
          
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