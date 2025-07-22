import duckdb from 'duckdb';
import type { Database, Connection } from 'duckdb';
import type { HealthDataConfig } from '../types';

export class HealthDataDB {
  private db: Database;
  private connections: Map<string, Connection> = new Map();
  private config: HealthDataConfig & {
    maxMemoryMB: number;
    prewarmCache: boolean;
    rollingWindowDays: number;
  };
  
  constructor(config: HealthDataConfig) {
    this.config = {
      maxMemoryMB: 1024,
      prewarmCache: false,
      rollingWindowDays: 90,
      ...config
    };
    
    this.db = new duckdb.Database(':memory:');
  }
  
  async initialize(): Promise<void> {
    await this.setupDatabase();
  }
  
  private async setupDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(`
        SET memory_limit = '${this.config.maxMemoryMB}MB';
        SET threads = 4;
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
  
  async getMemoryUsage(): Promise<number> {
    const result = await this.execute(`
      SELECT current_setting('memory_limit') as memory_limit,
             current_setting('temp_directory_size') as temp_size
    `);
    return parseFloat(result[0]?.memory_limit || '0');
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