import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HealthDataDB } from '../../db/database';
import type { DetectedTable, DetectionResult, FormatImporter, TableKind } from '../types';

// Kind comes from the filename alone; detection reads no rows. Families the
// regex admits but the loader has never verified (e.g. HKWorkoutTypeIdentifier*)
// stay `other` rather than asserting a shape.
function kindForFile(fileName: string): TableKind {
  if (fileName.startsWith('HKWorkoutActivityType')) return 'workout';
  if (fileName.startsWith('HKCategoryTypeIdentifier')) return 'category';
  if (fileName.startsWith('HKQuantityTypeIdentifier')) return 'quantity';
  return 'other';
}

export class SimpleCsvImporter implements FormatImporter {
  readonly id = 'simple-health-export-csv';
  readonly displayName = 'Simple Health Export CSV';

  // Directory iteration order is preserved so duplicate canonical names keep
  // the catalog's last-entry-wins behavior.
  async detect(dataDir: string): Promise<DetectionResult> {
    const files = await readdir(dataDir);
    const tables: DetectedTable[] = [];

    for (const file of files) {
      // Workout exports are named HKWorkoutActivityType.csv or
      // HKWorkoutActivityTypeRunning.csv, with no literal "TypeIdentifier".
      // The name capture stops at the first non-alphanumeric character, so a
      // file like HKQuantityTypeIdentifierHeartRate_2026-07-21.csv still maps
      // to the plain hkquantitytypeidentifierheartrate table name.
      const match = file.match(/^(HK\w+?TypeIdentifier[A-Za-z0-9]+).*\.csv$/)
        || file.match(/^(HKWorkoutActivityType[A-Za-z0-9]*).*\.csv$/);
      if (!match) {
        continue;
      }

      tables.push({
        tableName: match[1].toLowerCase(),
        path: join(dataDir, file),
        kind: kindForFile(file)
      });
    }

    return { claimed: tables.length > 0, tables };
  }

  async load(db: HealthDataDB, table: DetectedTable): Promise<number> {
    await this.cleanAndOptimizeTable(db, table.path, table.tableName);

    // Count the final table: the load also drops rows with a null value, so
    // the recorded count matches what is actually stored. A file with no
    // readable rows still produces an empty table, so queries return zero rows
    // instead of a missing-table error and the CSV is not rescanned on every
    // request.
    const countResult = await db.execute(
      `SELECT COUNT(*) as count FROM ${table.tableName}`
    );
    return Number(countResult[0]?.count ?? 0);
  }

  // Column names come from CSV headers, and real exports contain metadata
  // columns with spaces, e.g. "Health Mate App Version" from Withings. Every
  // identifier taken from a header must be quoted.
  private quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  private csvSource(filePath: string): string {
    // Paths are not user queries, but a directory name like "Neil's Health"
    // contains a quote that would end the SQL literal early.
    const escapedPath = filePath.replace(/'/g, "''");
    // sample_size = -1 sniffs column types from the whole file, not the first
    // ~20k rows. Metadata columns like sourceVersion look numeric for months
    // ("10.5") and then stop ("11.0.1"); a sampled DOUBLE guess turns every
    // later row into a CAST error that ignore_errors silently drops.
    return `read_csv('${escapedPath}',
        header = true,
        skip = 1,
        delim = ',',
        quote = '"',
        escape = '"',
        ignore_errors = true,
        null_padding = true,
        new_line = '\\r\\n',
        sample_size = -1
      )`;
  }

  private async cleanAndOptimizeTable(
    db: HealthDataDB,
    filePath: string,
    finalTable: string
  ): Promise<void> {
    // Drop existing table if it exists
    await db.run(`DROP TABLE IF EXISTS ${finalTable}`);

    const source = this.csvSource(filePath);

    // Health exports come in several shapes. Quantity CSVs have unit and value,
    // category CSVs have no unit, workout CSVs have neither and carry duration
    // and energy columns instead. Sniff the columns first so the projection is
    // built from the columns that are actually present and every shape loads.
    // DESCRIBE only samples the file; it materializes no rows.
    const describedColumns = await db.execute(`DESCRIBE SELECT * FROM ${source}`);
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
      const ident = this.quoteIdent(name);
      if (lower === 'startdate' || lower === 'enddate') {
        selectParts.push(`TRY_CAST(SUBSTR(${ident}, 1, 19) AS TIMESTAMP) as ${ident}`);
      } else if (lower === 'value') {
        // Category rows hold text labels like HKCategoryValueSleepAnalysisAsleepCore.
        // Keep the numeric cast for quantity queries and keep the raw label in valueText.
        selectParts.push(`TRY_CAST(${ident} AS DOUBLE) as ${ident}`);
        selectParts.push(`CAST(${ident} AS VARCHAR) as valueText`);
      } else {
        selectParts.push(ident);
      }
    }

    // Keep every row whose startDate can become a timestamp. There is no
    // history window; an invalid startDate, and a null value where the shape
    // has a value column, are the only exclusions.
    const conditions: string[] = [
      `TRY_CAST(SUBSTR(${this.quoteIdent(startDateCol)}, 1, 19) AS TIMESTAMP) IS NOT NULL`,
    ];
    if (valueCol) {
      conditions.push(`${this.quoteIdent(valueCol)} IS NOT NULL`);
    }
    const whereClause = `\n      WHERE ${conditions.join('\n        AND ')}`;

    // One pass from CSV straight into the typed final table. Staging the raw
    // rows first would hold both copies resident and roughly double peak memory
    // for a large export.
    await db.run(`
      CREATE TABLE ${finalTable} AS
      SELECT
        ${selectParts.join(',\n        ')}
      FROM ${source}${whereClause}
    `);

    // Create indexes for common query patterns
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_${finalTable}_startdate
      ON ${finalTable}(${this.quoteIdent(startDateCol)})
    `);

    if (typeCol) {
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_${finalTable}_type
        ON ${finalTable}(${this.quoteIdent(typeCol)})
      `);
    }
  }
}
