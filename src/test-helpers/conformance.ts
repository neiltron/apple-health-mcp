import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from '../db/database';
import { FileCatalog } from '../db/catalog';
import { TableLoader } from '../db/loader';
import { ImporterRegistry } from '../importers/registry';
import type { FormatImporter } from '../importers/types';

// What a format's fixture writer must produce so the shared invariants can be
// asserted against it. Every table name is the canonical lowercase HK
// identifier the importer is expected to detect.
export interface ConformanceExpectations {
  // Quantity-kind table containing, in any order:
  // - `validRows` rows with numeric values and valid timestamps, one of which
  //   is dated decades in the past (year `oldRowYear`)
  // - one row whose value is the non-numeric text `nonNumericValueText`
  //   (loads with numeric value NULL, text preserved)
  // - one row with an unparseable startDate (excluded)
  // - one row with an empty value (excluded)
  // - one row with an unparseable endDate (still loads)
  quantityTable: string;
  validRows: number;
  oldRowYear: number;
  nonNumericValueText: string;
  // Category-kind table with at least one row labeled `categoryLabel`.
  categoryTable: string;
  categoryLabel: string;
  // Workout-kind table whose single row spans `workoutDurationSeconds` between
  // startDate and endDate and carries the format-specific `workoutColumn`.
  workoutTable: string;
  workoutColumn: string;
  workoutDurationSeconds: number;
  // A recognized file that yields zero loadable rows.
  emptyTable: string;
  // A recognized file whose load must fail (and leave no partial table).
  brokenTable: string;
}

// End-to-end importer integration suite: wires a real catalog, loader, and
// DuckDB around the importer and asserts the canonical table contract every
// format must satisfy. Format-specific quirks belong in per-importer tests.
export function runFormatConformance(
  importer: FormatImporter,
  writeFixtures: (dir: string) => ConformanceExpectations
): void {
  describe(`format conformance: ${importer.displayName}`, () => {
    let dataDir: string;
    let db: HealthDataDB;
    let catalog: FileCatalog;
    let loader: TableLoader;
    let expected: ConformanceExpectations;

    beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'format-conformance-'));
      expected = writeFixtures(dataDir);

      db = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
      await db.initialize();
      catalog = new FileCatalog(dataDir, new ImporterRegistry([importer]));
      await catalog.initialize();
      loader = new TableLoader(db, catalog);
    });

    afterAll(async () => {
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    async function columnTypes(table: string): Promise<Map<string, string>> {
      const columns = await db.execute(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = '${table}'
      `);
      return new Map(
        columns.map((col: any) => [String(col.column_name).toLowerCase(), String(col.data_type)])
      );
    }

    async function tableExists(table: string): Promise<boolean> {
      const result = await db.execute(`
        SELECT COUNT(*) as count FROM information_schema.tables
        WHERE table_name = '${table}'
      `);
      return Number(result[0]?.count ?? 0) > 0;
    }

    test('detection produces canonical lowercase names with correct kinds', () => {
      const tables = catalog.getAllTables();
      expect(tables).toContain(expected.quantityTable);
      expect(tables).toContain(expected.categoryTable);
      expect(tables).toContain(expected.workoutTable);
      expect(tables).toContain(expected.emptyTable);
      for (const name of tables) {
        expect(name).toBe(name.toLowerCase());
      }
      expect(catalog.getEntry(expected.quantityTable)?.kind).toBe('quantity');
      expect(catalog.getEntry(expected.categoryTable)?.kind).toBe('category');
      expect(catalog.getEntry(expected.workoutTable)?.kind).toBe('workout');
    });

    test('a detected table is not materialized until first requested', async () => {
      expect(await tableExists(expected.quantityTable)).toBe(false);
      await loader.ensureTableLoaded(expected.quantityTable);
      expect(await tableExists(expected.quantityTable)).toBe(true);
    });

    test('quantity rows land typed: timestamps, numeric value, preserved text', async () => {
      await loader.ensureTableLoaded(expected.quantityTable);
      const types = await columnTypes(expected.quantityTable);
      expect(types.get('startdate')).toBe('TIMESTAMP');
      if (types.has('enddate')) {
        expect(types.get('enddate')).toBe('TIMESTAMP');
      }
      expect(types.get('value')).toBe('DOUBLE');

      // Raw text survives alongside the numeric cast.
      const nonNumeric = await db.execute(`
        SELECT value, valueText FROM ${expected.quantityTable}
        WHERE valueText = '${expected.nonNumericValueText}'
      `);
      expect(nonNumeric.length).toBe(1);
      expect(nonNumeric[0].value).toBeNull();
    });

    test('row exclusions match the contract', async () => {
      await loader.ensureTableLoaded(expected.quantityTable);
      // validRows + the non-numeric row + the invalid-endDate row survive;
      // the invalid-startDate row and the empty-value row are excluded.
      const result = await db.execute(
        `SELECT COUNT(*) as count FROM ${expected.quantityTable}`
      );
      expect(Number(result[0].count)).toBe(expected.validRows + 2);

      // endDate is not validated: the invalid-endDate row loads with NULL.
      const nullEnd = await db.execute(`
        SELECT COUNT(*) as count FROM ${expected.quantityTable} WHERE endDate IS NULL
      `);
      expect(Number(nullEnd[0].count)).toBe(1);
    });

    test('full history loads with no date window', async () => {
      await loader.ensureTableLoaded(expected.quantityTable);
      const result = await db.execute(`
        SELECT COUNT(*) as count FROM ${expected.quantityTable}
        WHERE EXTRACT(year FROM startDate) = ${expected.oldRowYear}
      `);
      expect(Number(result[0].count)).toBeGreaterThan(0);
    });

    test('load returns a row count equal to the stored count', async () => {
      await loader.ensureTableLoaded(expected.quantityTable);
      const stored = await db.execute(
        `SELECT COUNT(*) as count FROM ${expected.quantityTable}`
      );
      expect(catalog.getEntry(expected.quantityTable)?.rowCount).toBe(
        Number(stored[0].count)
      );
    });

    test('category labels land in valueText with numeric value NULL', async () => {
      await loader.ensureTableLoaded(expected.categoryTable);
      const rows = await db.execute(`
        SELECT value, valueText FROM ${expected.categoryTable}
        WHERE valueText = '${expected.categoryLabel}'
      `);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].value).toBeNull();
    });

    test('workout columns are retained and duration derives from timestamps', async () => {
      await loader.ensureTableLoaded(expected.workoutTable);
      const types = await columnTypes(expected.workoutTable);
      expect(types.has(expected.workoutColumn.toLowerCase())).toBe(true);

      const rows = await db.execute(`
        SELECT DATE_DIFF('second', startDate, endDate) as seconds
        FROM ${expected.workoutTable}
      `);
      expect(Number(rows[0].seconds)).toBe(expected.workoutDurationSeconds);
    });

    test('a file with no loadable rows produces an empty table marked loaded', async () => {
      await loader.ensureTableLoaded(expected.emptyTable);
      const entry = catalog.getEntry(expected.emptyTable);
      expect(entry?.loaded).toBe(true);
      expect(entry?.rowCount).toBe(0);
      const result = await db.execute(
        `SELECT COUNT(*) as count FROM ${expected.emptyTable}`
      );
      expect(Number(result[0].count)).toBe(0);
    });

    test('a failed load raises and leaves no partial table', async () => {
      await expect(loader.ensureTableLoaded(expected.brokenTable)).rejects.toThrow();
      expect(await tableExists(expected.brokenTable)).toBe(false);
      expect(catalog.getEntry(expected.brokenTable)?.loaded).toBe(false);
    });
  });
}
