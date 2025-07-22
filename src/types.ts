export interface CatalogEntry {
  path: string;
  loaded: boolean;
  rowCount: number | null;
  lastAccessed?: Date;
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  executionTime: number;
}

export interface CachedResult {
  result: QueryResult;
  timestamp: number;
  ttl: number;
}

export interface HealthDataConfig {
  dataDir: string;
  cacheDir?: string;
  maxMemoryMB?: number;
  prewarmCache?: boolean;
  rollingWindowDays?: number;
}

export type OutputFormat = 'json' | 'csv' | 'summary';

export interface HealthQueryArgs {
  query: string;
  format?: OutputFormat;
}

export interface HealthReportArgs {
  report_type: 'weekly' | 'monthly' | 'custom';
  start_date?: string;
  end_date?: string;
  include_metrics?: string[];
}