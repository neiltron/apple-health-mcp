import type { HealthDataDB } from '../db/database';
import type { FileCatalog } from '../db/catalog';
import type { TableLoader } from '../db/loader';

export class MemoryManager {
  private db: HealthDataDB;
  private catalog: FileCatalog;
  private loader: TableLoader;
  private maxMemoryMB: number;
  private checkInterval: number = 30000; // 30 seconds
  private intervalId?: Timer;
  
  constructor(
    db: HealthDataDB, 
    catalog: FileCatalog, 
    loader: TableLoader,
    maxMemoryMB: number = 1024
  ) {
    this.db = db;
    this.catalog = catalog;
    this.loader = loader;
    this.maxMemoryMB = maxMemoryMB;
  }
  
  startMonitoring(): void {
    this.intervalId = setInterval(() => {
      this.checkMemoryPressure().catch(console.error);
    }, this.checkInterval);
    
    console.log('Memory monitoring started');
  }
  
  stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('Memory monitoring stopped');
    }
  }
  
  private async checkMemoryPressure(): Promise<void> {
    try {
      const memoryUsage = await this.getEstimatedMemoryUsage();
      const threshold = this.maxMemoryMB * 0.8;
      
      if (memoryUsage > threshold) {
        console.log(`Memory pressure detected: ${memoryUsage}MB / ${this.maxMemoryMB}MB`);
        await this.evictLRUTables();
      }
    } catch (error) {
      console.error('Error checking memory pressure:', error);
    }
  }
  
  private async getEstimatedMemoryUsage(): Promise<number> {
    // Estimate based on loaded tables and their row counts
    const loadedTables = this.catalog.getLoadedTables();
    let totalMemoryMB = 0;
    
    for (const table of loadedTables) {
      const entry = this.catalog.getEntry(table);
      if (entry?.rowCount) {
        // Rough estimate: 100 bytes per row
        totalMemoryMB += (entry.rowCount * 100) / (1024 * 1024);
      }
    }
    
    return totalMemoryMB;
  }
  
  private async evictLRUTables(): Promise<void> {
    const tables = this.catalog.getTablesByLastAccess();
    const targetMemory = this.maxMemoryMB * 0.6;
    
    for (const table of tables) {
      const currentUsage = await this.getEstimatedMemoryUsage();
      if (currentUsage < targetMemory) break;
      
      console.log(`Evicting table: ${table}`);
      await this.loader.unloadTable(table);
    }
  }
  
  async forceEviction(count: number): Promise<void> {
    const tables = this.catalog.getTablesByLastAccess();
    const toEvict = tables.slice(0, count);
    
    for (const table of toEvict) {
      await this.loader.unloadTable(table);
    }
  }
  
  getMemoryStats(): {
    maxMemoryMB: number;
    estimatedUsageMB: number;
    loadedTables: number;
    totalTables: number;
  } {
    const loadedTables = this.catalog.getLoadedTables();
    const allTables = this.catalog.getAllTables();
    
    return {
      maxMemoryMB: this.maxMemoryMB,
      estimatedUsageMB: 0, // Will be calculated async
      loadedTables: loadedTables.length,
      totalTables: allTables.length
    };
  }
}