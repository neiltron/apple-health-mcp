import type { HealthDataDB } from '../db/database';
import type { FileCatalog } from '../db/catalog';

export class HealthSchemaTool {
  private db: HealthDataDB;
  private catalog: FileCatalog;
  
  constructor(db: HealthDataDB, catalog: FileCatalog) {
    this.db = db;
    this.catalog = catalog;
  }
  
  async execute(): Promise<any> {
    // Get available tables from catalog
    const tableInfo = this.catalog.getTableInfo();
    const availableTables = Object.keys(tableInfo);
    
    if (availableTables.length === 0) {
      return {
        error: "No health data tables found",
        suggestion: "Check that HEALTH_DATA_DIR contains CSV files"
      };
    }
    
    // Load a sample from key tables to show structure (including workouts/distance for unit hints)
    const sampleTables = availableTables
      .filter(name =>
        name.includes('heartrate') ||
        name.includes('stepcount') ||
        name.includes('sleepanalysis') ||
        name.includes('activeenergyburned') ||
        name.includes('distancewalkingrunning') ||
        name.includes('distancecycling') ||
        name.includes('workout')
      )
      .slice(0, 8);
    
    const schema: any = {
      summary: {
        totalTables: availableTables.length,
        loadedTables: availableTables.filter(name => tableInfo[name].loaded).length,
        sampleTablesShown: sampleTables.length
      },
      availableTables: availableTables.sort(),
      tableDetails: {}
    };
    
    // Get schema information for sample tables
    for (const tableName of sampleTables) {
      try {
        // Ensure table is loaded
        const entry = this.catalog.getEntry(tableName);
        if (!entry?.loaded) {
          // Load a small sample to get schema
          await this.loadTableSample(tableName, entry!.path);
        }
        
        // Get column information
        const columns = await this.db.execute(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = '${tableName}'
          ORDER BY ordinal_position
        `);
        
        // Get sample data
        const sampleData = await this.db.execute(`
          SELECT * FROM ${tableName}
          ORDER BY startDate DESC
          LIMIT 3
        `);

        // Get distinct units for this table (sorted by frequency)
        const unitInfo = await this.db.execute(`
          SELECT unit, COUNT(*) as count
          FROM ${tableName}
          WHERE unit IS NOT NULL
          GROUP BY unit
          ORDER BY count DESC
        `);
        
        // Get data statistics
        const stats = await this.db.execute(`
          SELECT 
            COUNT(*) as total_rows,
            MIN(DATE(startDate)) as earliest_date,
            MAX(DATE(startDate)) as latest_date,
            COUNT(DISTINCT DATE(startDate)) as unique_dates
          FROM ${tableName}
          WHERE startDate IS NOT NULL
        `);
        
        schema.tableDetails[tableName] = {
          columns: columns.map((col: any) => ({
            name: col.column_name,
            type: col.data_type
          })),
          units: unitInfo.map((u: any) => u.unit),
          primaryUnit: unitInfo[0]?.unit || 'unknown',
          sampleRows: sampleData.slice(0, 2), // Show only 2 rows to keep response manageable
          statistics: stats[0] || {}
        };
        
      } catch (error) {
        schema.tableDetails[tableName] = {
          error: `Failed to load table: ${error}`,
          available: false
        };
      }
    }
    
    // Add common table patterns for reference
    schema.commonPatterns = {
      heartRate: availableTables.filter(t => t.includes('heartrate')),
      activity: availableTables.filter(t => t.includes('stepcount') || t.includes('distance') || t.includes('calories')),
      sleep: availableTables.filter(t => t.includes('sleep')),
      workouts: availableTables.filter(t => t.includes('workout')),
      vitals: availableTables.filter(t => t.includes('bloodpressure') || t.includes('temperature') || t.includes('oxygen'))
    };
    
    // Add query tips
    schema.queryTips = [
      "IMPORTANT: Always check the 'unit' column - units vary by source device (e.g., km vs m vs mi)",
      "Include 'unit' in SELECT statements when querying values to verify units",
      "Table names are lowercase versions of the CSV filenames",
      "Always filter by date: WHERE startDate >= 'YYYY-MM-DD'",
      "Use DATE(startDate) for daily grouping",
      "Use CURRENT_DATE - INTERVAL '30 days' for recent data"
    ];

    // Build unit reference from all sampled tables
    schema.unitReference = {} as Record<string, string>;
    for (const [tableName, details] of Object.entries(schema.tableDetails)) {
      const tableDetails = details as any;
      if (tableDetails.primaryUnit && tableDetails.primaryUnit !== 'unknown') {
        schema.unitReference[tableName] = tableDetails.primaryUnit;
      }
    }

    return schema;
  }
  
  private async loadTableSample(tableName: string, filePath: string): Promise<void> {
    const tempTableName = `${tableName}_sample`;
    
    try {
      // Load just a few rows to get schema
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
        LIMIT 100
      `);
      
      // Clean up timestamps and create final table
      await this.db.run(`
        CREATE TABLE ${tableName} AS
        SELECT 
          type,
          sourceName,
          sourceVersion,
          unit,
          TRY_CAST(SUBSTR(startDate, 1, 19) AS TIMESTAMP) as startDate,
          TRY_CAST(SUBSTR(endDate, 1, 19) AS TIMESTAMP) as endDate,
          TRY_CAST(value AS DOUBLE) as value,
          device,
          productType
        FROM ${tempTableName}
        WHERE value IS NOT NULL
      `);
      
      // Clean up
      await this.db.run(`DROP TABLE ${tempTableName}`);
      
      // Mark as loaded in catalog
      this.catalog.markLoaded(tableName, 100); // Approximate count
      
    } catch (error) {
      // Clean up on error
      await this.db.run(`DROP TABLE IF EXISTS ${tempTableName}`);
      throw error;
    }
  }
}