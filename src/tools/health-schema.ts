import type { HealthDataDB } from '../db/database';
import type { FileCatalog } from '../db/catalog';
import type { TableLoader } from '../db/loader';

export class HealthSchemaTool {
  private db: HealthDataDB;
  private catalog: FileCatalog;
  private loader: TableLoader;

  constructor(db: HealthDataDB, catalog: FileCatalog, loader: TableLoader) {
    this.db = db;
    this.catalog = catalog;
    this.loader = loader;
  }
  
  async execute(): Promise<any> {
    // Pick up files exported after the server started. A failed rescan is not
    // fatal, so fall back to the catalog we already have.
    try {
      await this.catalog.refresh();
    } catch {
      // keep the existing catalog
    }

    // Get available tables from catalog
    const tableInfo = this.catalog.getTableInfo();
    const availableTables = Object.keys(tableInfo);
    const scanConflict = this.catalog.getScanConflict();

    if (availableTables.length === 0) {
      // A multi-format directory looks exactly like an empty one from here;
      // the generic hint would be actively misleading, so surface the
      // conflict's actionable message instead.
      if (scanConflict) {
        return {
          error: `Multiple export formats found: ${scanConflict.formats.join(', ')}`,
          suggestion: scanConflict.message
        };
      }
      return {
        error: "No health data tables found",
        suggestion: "Check that HEALTH_DATA_DIR contains CSV files"
      };
    }

    // Workout classification comes from catalog kind metadata, the same
    // source health_report uses.
    const workoutTables = new Set(this.catalog.getTablesByKind('workout'));

    // Load a sample from key tables to show structure (including workouts/distance
    // for unit hints). Sampling keeps the name heuristic alongside the kind so
    // workout-adjacent quantity tables (e.g. WorkoutEffortScore) still get
    // their details and unit hints shown; classification below stays kind-only.
    const sampleTables = availableTables
      .filter(name =>
        name.includes('heartrate') ||
        name.includes('stepcount') ||
        name.includes('sleepanalysis') ||
        name.includes('activeenergyburned') ||
        name.includes('distancewalkingrunning') ||
        name.includes('distancecycling') ||
        name.includes('workout') ||
        workoutTables.has(name)
      )
      .slice(0, 8);
    
    const schema: any = {
      summary: {
        totalTables: availableTables.length,
        sampleTablesShown: sampleTables.length
      },
      availableTables: availableTables.sort(),
      tableDetails: {}
    };
    
    // Get schema information for sample tables
    for (const tableName of sampleTables) {
      try {
        // Materialize the table's full history so later queries see every row.
        // A load failure throws and is reported by the catch below.
        await this.loader.ensureTableLoaded(tableName);

        // A file can load as an empty table when its dates are unparseable or
        // every value is null. Say so plainly rather than reporting empty
        // statistics.
        if (this.catalog.getEntry(tableName)?.rowCount === 0) {
          schema.tableDetails[tableName] = {
            note: 'no rows loaded from this file (unparseable dates or empty values)'
          };
          continue;
        }

        // Get column information
        const columns = await this.db.execute(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = '${tableName}'
          ORDER BY ordinal_position
        `);

        const hasUnitColumn = columns.some(
          (col: any) => String(col.column_name).toLowerCase() === 'unit'
        );

        // Get sample data
        const sampleData = await this.db.execute(`
          SELECT * FROM ${tableName}
          ORDER BY startDate DESC
          LIMIT 3
        `);

        // Get distinct units for this table (sorted by frequency).
        // Category and workout tables have no unit column.
        const unitInfo = hasUnitColumn
          ? await this.db.execute(`
              SELECT unit, COUNT(*) as count
              FROM ${tableName}
              WHERE unit IS NOT NULL
              GROUP BY unit
              ORDER BY count DESC
            `)
          : [];

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
    
    const loadedNow = this.catalog.getTableInfo();
    schema.summary.tablesInMemory = availableTables.filter(name => loadedNow[name]?.loaded).length;
    schema.summary.loadingNote = 'Tables load into memory on demand. A low tablesInMemory count is normal. Every table in availableTables is queryable.';

    // Add common table patterns for reference
    schema.commonPatterns = {
      heartRate: availableTables.filter(t => t.includes('heartrate')),
      activity: availableTables.filter(t => t.includes('stepcount') || t.includes('distance') || t.includes('calories')),
      sleep: availableTables.filter(t => t.includes('sleep')),
      workouts: availableTables.filter(t => workoutTables.has(t)),
      vitals: availableTables.filter(t => t.includes('bloodpressure') || t.includes('temperature') || t.includes('oxygen'))
    };

    // A conflict recorded over a previously valid catalog: the tables below
    // are still queryable, but new files are not being picked up.
    if (scanConflict) {
      schema.scanWarning = scanConflict.message;
    }
    
    // Add query tips
    schema.queryTips = [
      "IMPORTANT: Always check the 'unit' column - units vary by source device (e.g., km vs m vs mi)",
      "Include 'unit' in SELECT statements when querying values to verify units",
      "Category tables (sleep stages, stand hours) keep their text label in the valueText column - the numeric value column is NULL for these rows",
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
}