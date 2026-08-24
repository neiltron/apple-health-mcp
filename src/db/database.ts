import duckdb from 'duckdb';
import type { Database, Connection } from 'duckdb';
import type { HealthDataConfig } from '../types';

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
  
  // Directory names can contain a single quote ("Neil's Health"); escape it so
  // the path stays inside its SQL literal, the same way the CSV loader does.
  private sqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
  }

  private async setupDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Security boundary (see docs/architecture.md "Query boundary"):
      // confine all file access to the health data directory, disable external
      // access, and lock the configuration so no later query can loosen any of
      // it. read_csv on catalog files inside HEALTH_DATA_DIR keeps working;
      // read_text('/etc/hosts'), COPY TO, ATTACH, and extension loading fail at
      // the engine. lock_configuration must be the final statement.
      //
      // Zero temporary capacity keeps health rows in memory. A load that does
      // not fit fails loudly instead of spilling personal data to disk.
      const dataDir = this.sqlLiteral(this.config.dataDir);
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