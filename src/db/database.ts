import duckdb from 'duckdb';
import type { Database, Connection } from 'duckdb';
import type { HealthDataConfig } from '../types';
import { escapeSqlLiteral } from '../utils';

export type QueryInspection = 'accepted' | 'statement-rejected' | 'restricted-function' | 'validator-failure';

const RESTRICTED_QUERY_FUNCTIONS = new Set([
  'enable_logging',
  'disable_logging',
  'truncate_duckdb_logs',
  'write_log',
  'query',
  'json_execute_serialized_sql'
]);

// DuckDB's serializer only emits SELECT statements, or error:true for
// anything else, so statement family is the error flag and statement count is
// the array length. The reviver visits every key; recursion depth is bounded by
// the parser's max_expression_depth (1000).
function inspectSerializedQuery(serialized: any): QueryInspection {
  let restricted = false;
  let ast: any;
  try {
    ast = JSON.parse(String(serialized), (key, value) => {
      if (key === 'function_name' && RESTRICTED_QUERY_FUNCTIONS.has(String(value).toLowerCase())) {
        restricted = true;
      }
      return value;
    });
  } catch {
    return 'validator-failure';
  }
  if (ast?.error === true) return 'statement-rejected';
  if (!Array.isArray(ast?.statements)) return 'validator-failure';
  if (ast.statements.length !== 1) return 'statement-rejected';
  return restricted ? 'restricted-function' : 'accepted';
}

export class HealthDataDB {
  private db: Database;
  private connections: Map<string, Connection> = new Map();
  private config: HealthDataConfig & {
    maxMemoryMB: number;
    prewarmCache: boolean;
  };

  constructor(config: HealthDataConfig) {
    this.config = {
      // A two-year multi-table export holds roughly 1 GiB resident in DuckDB,
      // so 2048MB leaves headroom for loading full history. MAX_MEMORY_MB
      // remains the user override.
      maxMemoryMB: 2048,
      prewarmCache: false,
      ...config
    };
    
    this.db = new duckdb.Database(':memory:');
  }
  
  async initialize(): Promise<void> {
    await this.setupDatabase();
  }
  
  private async setupDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Engine defense in depth (see docs/architecture.md "Query guardrails"):
      // constrain file access outside the health data directory, disable
      // external access, and lock the configuration so later queries cannot
      // loosen those settings. The allowlisted directory remains readable and
      // writable: catalog read_csv calls and direct in-directory COPY work.
      // Bundled LOAD can also succeed at the engine; health_query's separate
      // statement gate rejects top-level COPY and LOAD. lock_configuration
      // must be the final statement.
      //
      // Zero temporary capacity keeps health rows in memory. A load that does
      // not fit fails loudly instead of spilling personal data to disk.
      const dataDir = escapeSqlLiteral(this.config.dataDir);
      this.db.run(`
        SET memory_limit = '${this.config.maxMemoryMB}MB';
        SET threads = 4;
        SET max_temp_directory_size = '0 bytes';
        SET allowed_directories = ['${dataDir}'];
        SET enable_external_access = false;
        SET lock_configuration = true;
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  
  async getConnection(sessionId: string = 'default'): Promise<Connection> {
    if (!this.connections.has(sessionId)) {
      const conn = this.db.connect();
      this.connections.set(sessionId, conn);
    }
    return this.connections.get(sessionId)!;
  }
  
  async releaseConnection(sessionId: string): Promise<void> {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.close();
      this.connections.delete(sessionId);
    }
  }
  
  async execute(query: string, sessionId?: string): Promise<any[]> {
    const conn = await this.getConnection(sessionId);

    return new Promise((resolve, reject) => {
      conn.all(query, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // DuckDB's serializer provides statement-family/count classification and an
  // AST to inspect; it does not prove semantic read-only behavior. Keep the
  // policy narrow by scanning only exact function_name fields for the known
  // logging operations and their dynamic-SQL bypass. Query text remains a
  // bound VARCHAR, never interpolated into the validator SQL.
  async inspectQuery(query: string, sessionId?: string): Promise<QueryInspection> {
    let conn: Connection;
    try {
      conn = await this.getConnection(sessionId);
    } catch {
      return 'validator-failure';
    }

    return new Promise((resolve) => {
      try {
        conn.all(
          'SELECT json_serialize_sql(?::VARCHAR) AS ast',
          query,
          (err, result) => {
            if (err || !Array.isArray(result) || result.length !== 1) {
              resolve('validator-failure');
              return;
            }
            try {
              resolve(inspectSerializedQuery(result[0]?.ast));
            } catch {
              resolve('validator-failure');
            }
          }
        );
      } catch {
        resolve('validator-failure');
      }
    });
  }
  
  async run(query: string, sessionId?: string): Promise<void> {
    const conn = await this.getConnection(sessionId);
    
    return new Promise((resolve, reject) => {
      conn.run(query, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  
  async close(): Promise<void> {
    for (const [sessionId] of this.connections) {
      await this.releaseConnection(sessionId);
    }
    
    return new Promise((resolve) => {
      this.db.close(() => resolve());
    });
  }
}