import type { CatalogEntry } from '../types';
import type { ImporterRegistry } from '../importers/registry';
import type { TableKind } from '../importers/types';
import { MultipleFormatsError } from '../importers/registry';

// Recorded when a scan finds more than one export format in the data
// directory. Retained so tools can show the actionable message instead of the
// generic empty-catalog hint; cleared by the next successful scan.
export interface ScanConflict {
  formats: string[];
  message: string;
}

interface CatalogTableInfo {
  [tableName: string]: CatalogEntry;
}

// Serialization for the health://tables resource. Catalog entries also hold
// local file paths and importer references, which stay out of protocol
// responses; only these fields ever leave the process.
export function projectTableInfo(
  info: CatalogTableInfo
): Array<{ name: string; loaded: boolean; rowCount: number | null }> {
  return Object.entries(info)
    .map(([name, entry]) => ({
      name,
      loaded: entry.loaded,
      rowCount: entry.rowCount
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class FileCatalog {
  private catalog: Map<string, CatalogEntry> = new Map();
  private dataDir: string;
  private registry: ImporterRegistry;
  private scanConflict: ScanConflict | null = null;

  constructor(dataDir: string, registry: ImporterRegistry) {
    this.dataDir = dataDir;
    this.registry = registry;
  }

  async initialize(): Promise<void> {
    await this.scanDirectory();
  }

  // Re-scan the data directory so files added after startup become queryable.
  async refresh(): Promise<void> {
    await this.scanDirectory();
  }

  getScanConflict(): ScanConflict | null {
    return this.scanConflict;
  }

  private async scanDirectory(): Promise<void> {
    // Detection completes before the catalog mutates, so a failed or
    // conflicting scan leaves the existing catalog untouched.
    let tables;
    try {
      tables = await this.registry.detectAll(this.dataDir);
    } catch (error) {
      if (error instanceof MultipleFormatsError) {
        this.scanConflict = { formats: error.formats, message: error.message };
        throw error;
      }
      // A non-conflict failure supersedes any recorded conflict: the status
      // always reflects the most recent scan outcome. Clearing is non-lossy —
      // a conflict that still exists re-records on the next completed
      // detection.
      this.scanConflict = null;
      throw new Error(`Failed to catalog health data files: ${error}`);
    }

    this.scanConflict = null;

    for (const table of tables) {
      const existing = this.catalog.get(table.tableName);

      // Keep loaded state for tables we have already seen at this path.
      if (existing && existing.path === table.path) {
        continue;
      }

      this.catalog.set(table.tableName, {
        path: table.path,
        loaded: false,
        rowCount: null,
        kind: table.kind,
        importer: table.importer
      });
    }
    // Entries whose files have disappeared are deliberately retained: loaded
    // tables stay queryable until evicted.
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
      .filter(([, entry]) => entry.loaded)
      .map(([name]) => name);
  }

  getTablesByLastAccess(): string[] {
    return Array.from(this.catalog.entries())
      .filter(([, entry]) => entry.loaded)
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

  // The one place table classification lives: kinds come from detection, so
  // tools never pattern-match table names.
  getTablesByKind(kind: TableKind): string[] {
    return Array.from(this.catalog.entries())
      .filter(([, entry]) => entry.kind === kind)
      .map(([name]) => name);
  }

  getTableInfo(): CatalogTableInfo {
    const info: CatalogTableInfo = {};
    for (const [name, entry] of this.catalog) {
      info[name] = { ...entry };
    }
    return info;
  }
}
