import type { HealthDataDB } from './database';
import type { FileCatalog } from './catalog';

export class TableLoader {
  private db: HealthDataDB;
  private catalog: FileCatalog;
  private rollingWindowDays: number;
  
  constructor(db: HealthDataDB, catalog: FileCatalog, rollingWindowDays: number = 90) {
    this.db = db;
    this.catalog = catalog;
    this.rollingWindowDays = rollingWindowDays;
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
    const tempTableName = `${tableName}_staging`;
    
    try {
      // console.log(`Loading table ${tableName} from ${filePath}`);
      
      // Create staging table with recent data only
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.rollingWindowDays);
      const cutoffStr = cutoffDate.toISOString().split('T')[0];
      
      await this.db.run(`
        CREATE TABLE ${tempTableName} AS
        SELECT * FROM read_csv('${filePath}',
          header = true,
          skip = 1,
          delim = ',',
          quote = '"',
          escape = '"',
          ignore_errors = true,
          null_padding = true,
          new_line = '\\r\\n'
        )
        WHERE TRY_CAST(SUBSTR(startDate, 1, 19) AS TIMESTAMP) >= '${cutoffStr}'
      `);
      
      // Get row count
      const countResult = await this.db.execute(
        `SELECT COUNT(*) as count FROM ${tempTableName}`
      );
      const rowCount = countResult[0]?.count || 0;
      
      if (rowCount > 0) {
        // Clean and create final table
        await this.cleanAndOptimizeTable(tempTableName, tableName);
        this.catalog.markLoaded(tableName, rowCount);
        // console.log(`Loaded ${rowCount} rows into ${tableName}`);
      } else {
        // Drop empty staging table
        await this.db.run(`DROP TABLE IF EXISTS ${tempTableName}`);
        // console.log(`No recent data found for ${tableName}`);
      }
    } catch (error) {
      // Clean up on error
      await this.db.run(`DROP TABLE IF EXISTS ${tempTableName}`);
      throw new Error(`Failed to load table ${tableName}: ${error}`);
    }
  }
  
  private async cleanAndOptimizeTable(stagingTable: string, finalTable: string): Promise<void> {
    // Drop existing table if it exists
    await this.db.run(`DROP TABLE IF EXISTS ${finalTable}`);

    // Health exports come in several shapes. Quantity CSVs have unit and value,
    // category CSVs have no unit, workout CSVs have neither and carry duration
    // and energy columns instead. Build the projection from the columns that
    // are actually present so every shape loads.
    const stagingColumns = await this.db.execute(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${stagingTable}'
      ORDER BY ordinal_position
    `);
    const columnNames: string[] = stagingColumns.map((col: any) => col.column_name);
    const columnByLower = new Map<string, string>();
    for (const name of columnNames) {
      columnByLower.set(name.toLowerCase(), name);
    }

    const startDateCol = columnByLower.get('startdate');
    const endDateCol = columnByLower.get('enddate');
    const valueCol = columnByLower.get('value');
    const typeCol = columnByLower.get('type');

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

    const whereClause = valueCol ? `\n      WHERE ${valueCol} IS NOT NULL` : '';

    // Create optimized table with proper types and indexes
    await this.db.run(`
      CREATE TABLE ${finalTable} AS
      SELECT
        ${selectParts.join(',\n        ')}
      FROM ${stagingTable}${whereClause}
    `);

    // Create indexes for common query patterns
    if (startDateCol) {
      await this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_${finalTable}_startdate
        ON ${finalTable}(${startDateCol})
      `);
    }

    if (typeCol) {
      await this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_${finalTable}_type
        ON ${finalTable}(${typeCol})
      `);
    }

    // Drop staging table
    await this.db.run(`DROP TABLE ${stagingTable}`);
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