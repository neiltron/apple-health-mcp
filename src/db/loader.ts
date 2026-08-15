import type { HealthDataDB } from './database';
import type { FileCatalog } from './catalog';

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
    
    await this.loadTable(tableName, entry.path);
  }
  
  private async loadTable(tableName: string, filePath: string): Promise<void> {
    try {
      await this.cleanAndOptimizeTable(filePath, tableName);

      // Count the final table: the load also drops rows with a null value, so
      // the catalog count matches what is actually stored. A file with no
      // readable rows still produces an empty table and is still marked loaded,
      // so queries return zero rows instead of a missing-table error and the
      // CSV is not rescanned on every request.
      const countResult = await this.db.execute(
        `SELECT COUNT(*) as count FROM ${tableName}`
      );
      const rowCount = Number(countResult[0]?.count ?? 0);
      this.catalog.markLoaded(tableName, rowCount);
    } catch (error) {
      // Clean up on error. There is no staging table, so the partially created
      // final table is the only thing that can be left behind.
      await this.db.run(`DROP TABLE IF EXISTS ${tableName}`);
      throw new Error(`Failed to load table ${tableName}: ${error}`);
    }
  }

  private csvSource(filePath: string): string {
    // Paths are not user queries, but a directory name like "Neil's Health"
    // contains a quote that would end the SQL literal early.
    const escapedPath = filePath.replace(/'/g, "''");
    return `read_csv('${escapedPath}',
        header = true,
        skip = 1,
        delim = ',',
        quote = '"',
        escape = '"',
        ignore_errors = true,
        null_padding = true,
        new_line = '\\r\\n'
      )`;
  }

  private async cleanAndOptimizeTable(filePath: string, finalTable: string): Promise<void> {
    // Drop existing table if it exists
    await this.db.run(`DROP TABLE IF EXISTS ${finalTable}`);

    const source = this.csvSource(filePath);

    // Health exports come in several shapes. Quantity CSVs have unit and value,
    // category CSVs have no unit, workout CSVs have neither and carry duration
    // and energy columns instead. Sniff the columns first so the projection is
    // built from the columns that are actually present and every shape loads.
    // DESCRIBE only samples the file; it materializes no rows.
    const describedColumns = await this.db.execute(`DESCRIBE SELECT * FROM ${source}`);
    const columnNames: string[] = describedColumns.map((col: any) => col.column_name);
    const columnByLower = new Map<string, string>();
    for (const name of columnNames) {
      columnByLower.set(name.toLowerCase(), name);
    }

    const startDateCol = columnByLower.get('startdate');
    const valueCol = columnByLower.get('value');
    const typeCol = columnByLower.get('type');

    // Every consumer sorts and filters on startDate. A CSV without that column
    // is not a loadable health export; fail here with a clear reason instead of
    // materializing a table that breaks every downstream query.
    if (!startDateCol) {
      throw new Error(`CSV has no startDate column: ${filePath}`);
    }

    const selectParts: string[] = [];
    for (const name of columnNames) {
      const lower = name.toLowerCase();
      if (lower === 'startdate' || lower === 'enddate') {
        selectParts.push(`TRY_CAST(SUBSTR(${name}, 1, 19) AS TIMESTAMP) as ${name}`);
      } else if (lower === 'value') {
        // Category rows hold text labels like HKCategoryValueSleepAnalysisAsleepCore.
        // Keep the numeric cast for quantity queries and keep the raw label in valueText.
        selectParts.push(`TRY_CAST(${name} AS DOUBLE) as ${name}`);
        selectParts.push(`CAST(${name} AS VARCHAR) as valueText`);
      } else {
        selectParts.push(name);
      }
    }

    // Keep every row whose startDate can become a timestamp. There is no
    // history window; an invalid startDate, and a null value where the shape
    // has a value column, are the only exclusions.
    const conditions: string[] = [
      `TRY_CAST(SUBSTR(${startDateCol}, 1, 19) AS TIMESTAMP) IS NOT NULL`,
    ];
    if (valueCol) {
      conditions.push(`${valueCol} IS NOT NULL`);
    }
    const whereClause = `\n      WHERE ${conditions.join('\n        AND ')}`;

    // One pass from CSV straight into the typed final table. Staging the raw
    // rows first would hold both copies resident and roughly double peak memory
    // for a large export.
    await this.db.run(`
      CREATE TABLE ${finalTable} AS
      SELECT
        ${selectParts.join(',\n        ')}
      FROM ${source}${whereClause}
    `);

    // Create indexes for common query patterns
    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_${finalTable}_startdate
      ON ${finalTable}(${startDateCol})
    `);

    if (typeCol) {
      await this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_${finalTable}_type
        ON ${finalTable}(${typeCol})
      `);
    }
  }
  
  async loadAllTables(): Promise<void> {
    const tables = this.catalog.getAllTables();
    // console.log(`Loading ${tables.length} tables...`);
    
    for (const table of tables) {
      try {
        await this.ensureTableLoaded(table);
      } catch (error) {
        // console.error(`Failed to load ${table}:`, error);
      }
    }
  }
  
  async unloadTable(tableName: string): Promise<void> {
    try {
      await this.db.run(`DROP TABLE IF EXISTS ${tableName}`);
      this.catalog.markUnloaded(tableName);
      // console.log(`Unloaded table ${tableName}`);
    } catch (error) {
      // console.error(`Failed to unload ${tableName}:`, error);
    }
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