import type { HealthDataDB } from '../db/database';
import type { QueryCache } from '../core/cache';
import type { TableLoader } from '../db/loader';
import type { HealthQueryArgs, QueryResult, OutputFormat } from '../types';

function isNumber(value: any): value is number {
  return Object(value) instanceof Number && Object(value) !== value;
}

// RFC 4180: a field whose text contains a comma, quote, or line break must
// be quoted, with embedded quotes doubled. Quoting keys off the rendered
// text, so composite values such as DuckDB lists stay a single field.
function escapeCsvField(value: any): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
    await this.validateQuery(query);

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
  
  // The filesystem boundary is enforced at the engine (allowed_directories +
  // locked config, see database.ts). This validator adds the one thing the
  // engine leaves open: it rejects anything that is not a single read-only
  // SELECT statement, so COPY (SELECT ...) TO a file inside the data directory
  // cannot write health data out. Statement kind and count are decided by
  // DuckDB's own parser, not substring matching, so complex queries — joins,
  // CTEs, nested subqueries, UNION — are all accepted, and a string literal
  // containing "reset" or "drop" is no longer a false positive.
  private async validateQuery(query: string): Promise<void> {
    const singleSelect = await this.db.isSingleSelect(query);
    if (!singleSelect) {
      throw new Error('Only a single read-only SELECT statement is allowed');
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
    lines.push(result.columns.map(escapeCsvField).join(','));

    // Rows
    for (const row of result.rows) {
      lines.push(row.map(escapeCsvField).join(','));
    }

    return lines.join('\n');
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
        result.rows.some(row => isNumber(row[idx]))
      );
      
      if (numericColumns.length > 0) {
        summary.statistics = {};
        
        for (const col of numericColumns) {
          const colIdx = result.columns.indexOf(col);
          const values = result.rows
            .map(row => row[colIdx])
            .filter(isNumber);
          
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