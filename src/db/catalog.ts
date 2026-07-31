import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogEntry } from '../types';

export class FileCatalog {
  private catalog: Map<string, CatalogEntry> = new Map();
  private dataDir: string;
  
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }
  
  async initialize(): Promise<void> {
    await this.scanDirectory();
  }

  // Re-scan the data directory so files added after startup become queryable.
  async refresh(): Promise<void> {
    await this.scanDirectory();
  }

  private async scanDirectory(): Promise<void> {
    try {
      const files = await readdir(this.dataDir);

      for (const file of files) {
        // Workout exports are named HKWorkoutActivityType.csv or
        // HKWorkoutActivityTypeRunning.csv, with no literal "TypeIdentifier".
        // The name capture stops at the first non-alphanumeric character, so a
        // file like HKQuantityTypeIdentifierHeartRate_2026-07-21.csv still maps
        // to the plain hkquantitytypeidentifierheartrate table name.
        const match = file.match(/^(HK\w+?TypeIdentifier[A-Za-z0-9]+).*\.csv$/)
          || file.match(/^(HKWorkoutActivityType[A-Za-z0-9]*).*\.csv$/);
        if (match) {
          const tableName = match[1].toLowerCase();
          const path = join(this.dataDir, file);
          const existing = this.catalog.get(tableName);

          // Keep loaded state for tables we have already seen at this path.
          if (existing && existing.path === path) {
            continue;
          }

          this.catalog.set(tableName, {
            path,
            loaded: false,
            rowCount: null
          });
        }
      }
      
      // console.log(`Found ${this.catalog.size} health data CSV files`);
    } catch (error) {
      // console.error(`Error scanning directory ${this.dataDir}:`, error);
      throw new Error(`Failed to catalog health data files: ${error}`);
    }
  }
  
  getTablePath(tableName: string): string | undefined {
    const entry = this.catalog.get(tableName.toLowerCase());
    return entry?.path;
  }
  
  getEntry(tableName: string): CatalogEntry | undefined {
    return this.catalog.get(tableName.toLowerCase());
  }
  
  markLoaded(tableName: string, rowCount: number): void {
    const entry = this.catalog.get(tableName.toLowerCase());
    if (entry) {
      entry.loaded = true;
      entry.rowCount = rowCount;
      entry.lastAccessed = new Date();
    }
  }
  
  markUnloaded(tableName: string): void {
    const entry = this.catalog.get(tableName.toLowerCase());
    if (entry) {
      entry.loaded = false;
    }
  }
  
  getLoadedTables(): string[] {
    return Array.from(this.catalog.entries())
      .filter(([_, entry]) => entry.loaded)
      .map(([name]) => name);
  }
  
  getTablesByLastAccess(): string[] {
    return Array.from(this.catalog.entries())
      .filter(([_, entry]) => entry.loaded)
      .sort((a, b) => {
        const timeA = a[1].lastAccessed?.getTime() || 0;
        const timeB = b[1].lastAccessed?.getTime() || 0;
        return timeA - timeB;
      })
      .map(([name]) => name);
  }
  
  getAllTables(): string[] {
    return Array.from(this.catalog.keys());
  }
  
  getTableInfo(): Record<string, CatalogEntry> {
    const info: Record<string, CatalogEntry> = {};
    for (const [name, entry] of this.catalog) {
      info[name] = { ...entry };
    }
    return info;
  }
}