import type { HealthDataDB } from './database';
import type { FileCatalog } from './catalog';
import type { CatalogEntry } from '../types';

export class TableLoader {
  private db: HealthDataDB;
  private catalog: FileCatalog;

  constructor(db: HealthDataDB, catalog: FileCatalog) {
    this.db = db;
    this.catalog = catalog;
  }

  async ensureTableLoaded(tableName: string): Promise<void> {
    const entry = this.catalog.getEntry(tableName);
    if (!entry) {
      throw new Error(`Table ${tableName} not found in catalog`);
    }

    if (entry.loaded) {
      entry.lastAccessed = new Date();
      return;
    }

    await this.loadTable(tableName, entry);
  }

  private async loadTable(tableName: string, entry: CatalogEntry): Promise<void> {
    const importer = entry.importer;
    if (!importer) {
      throw new Error(`Table ${tableName} has no importer in the catalog`);
    }

    try {
      // The importer owns materialization and returns the stored row count;
      // the loader owns lifecycle state. A file with no readable rows still
      // produces an empty table and is still marked loaded, so queries return
      // zero rows instead of a missing-table error and the source is not
      // rescanned on every request.
      const rowCount = await importer.load(this.db, {
        tableName,
        path: entry.path,
        kind: entry.kind ?? 'other'
      });
      this.catalog.markLoaded(tableName, rowCount);
    } catch (error) {
      // Clean up on error. There is no staging table, so the partially created
      // final table is the only thing that can be left behind.
      await this.db.run(`DROP TABLE IF EXISTS ${tableName}`);
      throw new Error(`Failed to load table ${tableName}: ${error}`);
    }
  }

  async loadAllTables(): Promise<void> {
    const tables = this.catalog.getAllTables();

    for (const table of tables) {
      try {
        await this.ensureTableLoaded(table);
      } catch {
        // A single unreadable file must not stop the rest of the export.
      }
    }
  }

  async unloadTable(tableName: string): Promise<void> {
    try {
      await this.db.run(`DROP TABLE IF EXISTS ${tableName}`);
      this.catalog.markUnloaded(tableName);
    } catch {
      // Eviction is best-effort; a failed drop leaves the table queryable.
    }
  }

  // Queries run against lazily loaded tables, so every table a query touches
  // must be materialized before execution.
  async ensureTablesForQuery(query: string): Promise<void> {
    const requiredTables = this.extractTableNames(query);
    await Promise.all(
      requiredTables.map(table => this.ensureTableLoaded(table))
    );
  }

  extractTableNames(query: string): string[] {
    const tables = new Set<string>();
    const allTables = this.catalog.getAllTables();

    // Simple regex to find table names in query
    const queryLower = query.toLowerCase();
    for (const table of allTables) {
      if (queryLower.includes(table)) {
        tables.add(table);
      }
    }

    return Array.from(tables);
  }
}
