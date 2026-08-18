import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCatalog, projectTableInfo } from './catalog';
import { defaultRegistry } from '../importers';
import { ImporterRegistry, MultipleFormatsError } from '../importers/registry';
import { SimpleCsvImporter } from '../importers/simple-csv/importer';
import type { FormatImporter } from '../importers/types';
import {
  writeCsv,
  formatTimestamp,
  daysAgo,
  QUANTITY_HEADER,
  WORKOUT_HEADER
} from '../test-helpers/csv-fixtures';

function quantityRow(): string {
  const start = formatTimestamp(daysAgo(1));
  return `HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,${start},${start},count/min,72`;
}

function workoutRow(type: string): string {
  const start = formatTimestamp(daysAgo(1));
  return `${type},Apple Watch,10.0,${start},${start},1800,400,5.5`;
}

let dataDir: string;
let catalog: FileCatalog;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'health-catalog-test-'));

  writeCsv(dataDir, 'HKQuantityTypeIdentifierHeartRate.csv', QUANTITY_HEADER, [quantityRow()]);
  writeCsv(dataDir, 'HKWorkoutActivityType.csv', WORKOUT_HEADER, [
    workoutRow('HKWorkoutActivityTypeRunning')
  ]);
  writeCsv(dataDir, 'HKWorkoutActivityTypeRunning.csv', WORKOUT_HEADER, [
    workoutRow('HKWorkoutActivityTypeRunning')
  ]);

  // Neither of these should be catalogued.
  writeFileSync(join(dataDir, 'notes.txt'), 'not health data\n');
  writeCsv(dataDir, 'Workout.csv', WORKOUT_HEADER, [workoutRow('HKWorkoutActivityTypeCycling')]);

  catalog = new FileCatalog(dataDir, defaultRegistry());
  await catalog.initialize();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('FileCatalog scanning', () => {
  test('catalogues a quantity export', () => {
    expect(catalog.getAllTables()).toContain('hkquantitytypeidentifierheartrate');
  });

  test('catalogues a single file workout export', () => {
    expect(catalog.getAllTables()).toContain('hkworkoutactivitytype');
  });

  test('catalogues a per type workout export', () => {
    expect(catalog.getAllTables()).toContain('hkworkoutactivitytyperunning');
  });

  test('records the path for a workout export', () => {
    expect(catalog.getTablePath('hkworkoutactivitytyperunning')).toBe(
      join(dataDir, 'HKWorkoutActivityTypeRunning.csv')
    );
  });

  test('strips filename suffixes from the table name', async () => {
    const suffixDir = mkdtempSync(join(tmpdir(), 'health-catalog-suffix-'));
    writeCsv(
      suffixDir,
      'HKQuantityTypeIdentifierHeartRate_2026-07-212_11-19-16_SimpleHealthExportCSV.csv',
      QUANTITY_HEADER,
      [quantityRow()]
    );
    writeCsv(
      suffixDir,
      'HKWorkoutActivityTypeCycling_2026-07-212_11-19-21_SimpleHealthExportCSV.csv',
      WORKOUT_HEADER,
      [workoutRow('HKWorkoutActivityTypeCycling')]
    );

    const suffixCatalog = new FileCatalog(suffixDir, defaultRegistry());
    await suffixCatalog.initialize();

    expect(suffixCatalog.getAllTables()).toContain('hkquantitytypeidentifierheartrate');
    expect(suffixCatalog.getAllTables()).toContain('hkworkoutactivitytypecycling');
    rmSync(suffixDir, { recursive: true, force: true });
  });

  test('ignores files that are not health exports', () => {
    const tables = catalog.getAllTables();
    expect(tables).not.toContain('notes');
    expect(tables).not.toContain('workout');
  });
});

describe('FileCatalog refresh', () => {
  test('picks up a file written after initialize', async () => {
    const lateDir = mkdtempSync(join(tmpdir(), 'health-catalog-late-'));
    const lateCatalog = new FileCatalog(lateDir, defaultRegistry());
    await lateCatalog.initialize();
    expect(lateCatalog.getAllTables()).toEqual([]);

    writeCsv(lateDir, 'HKQuantityTypeIdentifierStepCount.csv', QUANTITY_HEADER, [quantityRow()]);
    await lateCatalog.refresh();

    expect(lateCatalog.getAllTables()).toContain('hkquantitytypeidentifierstepcount');
    rmSync(lateDir, { recursive: true, force: true });
  });

  test('preserves loaded state for tables it already knows', async () => {
    catalog.markLoaded('hkquantitytypeidentifierheartrate', 42);
    await catalog.refresh();

    const entry = catalog.getEntry('hkquantitytypeidentifierheartrate');
    expect(entry?.loaded).toBe(true);
    expect(entry?.rowCount).toBe(42);
  });

  test('keeps entries for files that disappear', async () => {
    const goneDir = mkdtempSync(join(tmpdir(), 'health-catalog-gone-'));
    writeCsv(goneDir, 'HKQuantityTypeIdentifierHeartRate.csv', QUANTITY_HEADER, [quantityRow()]);

    const goneCatalog = new FileCatalog(goneDir, defaultRegistry());
    await goneCatalog.initialize();
    goneCatalog.markLoaded('hkquantitytypeidentifierheartrate', 7);

    rmSync(join(goneDir, 'HKQuantityTypeIdentifierHeartRate.csv'));
    await goneCatalog.refresh();

    const entry = goneCatalog.getEntry('hkquantitytypeidentifierheartrate');
    expect(entry?.loaded).toBe(true);
    expect(entry?.rowCount).toBe(7);
    rmSync(goneDir, { recursive: true, force: true });
  });

  test('resolves duplicate canonical names to the last directory entry', async () => {
    const dupDir = mkdtempSync(join(tmpdir(), 'health-catalog-dup-'));
    // Two suffixed exports of the same metric map to one table name.
    writeCsv(dupDir, 'HKQuantityTypeIdentifierHeartRate_2026-01-01.csv', QUANTITY_HEADER, [
      quantityRow()
    ]);
    writeCsv(dupDir, 'HKQuantityTypeIdentifierHeartRate_2026-07-21.csv', QUANTITY_HEADER, [
      quantityRow()
    ]);

    const dupCatalog = new FileCatalog(dupDir, defaultRegistry());
    await dupCatalog.initialize();

    // readdir order is what the old catalog used; the last entry wins.
    const { readdirSync } = await import('node:fs');
    const matching = readdirSync(dupDir).filter((f) => f.endsWith('.csv'));
    const expected = join(dupDir, matching[matching.length - 1]);

    expect(dupCatalog.getAllTables()).toEqual(['hkquantitytypeidentifierheartrate']);
    expect(dupCatalog.getTablePath('hkquantitytypeidentifierheartrate')).toBe(expected);
    rmSync(dupDir, { recursive: true, force: true });
  });
});

describe('FileCatalog entry metadata', () => {
  test('attaches kind and importer to entries', () => {
    expect(catalog.getEntry('hkquantitytypeidentifierheartrate')?.kind).toBe('quantity');
    expect(catalog.getEntry('hkworkoutactivitytype')?.kind).toBe('workout');
    expect(catalog.getEntry('hkworkoutactivitytype')?.importer).toBeDefined();
  });

  test('projectTableInfo strips path, importer, and kind from serialized output', () => {
    const projected = projectTableInfo(catalog.getTableInfo());

    expect(projected.length).toBeGreaterThan(0);
    for (const row of projected) {
      expect(Object.keys(row).sort()).toEqual(['loaded', 'name', 'rowCount']);
    }
    // Sorted by name, matching the health://tables contract.
    const names = projected.map((row) => row.name);
    expect(names).toEqual([...names].sort());
  });
});

function fakeClaimingImporter(): FormatImporter {
  return {
    id: 'fake-json',
    displayName: 'Fake JSON Export',
    detect: async () => ({ claimed: true, tables: [] }),
    load: async () => 0
  };
}

describe('FileCatalog multi-format conflict', () => {
  test('records a typed conflict, keeps the catalog, and clears on a clean scan', async () => {
    const mixedDir = mkdtempSync(join(tmpdir(), 'health-catalog-mixed-'));
    writeCsv(mixedDir, 'HKQuantityTypeIdentifierHeartRate.csv', QUANTITY_HEADER, [quantityRow()]);

    const fake = fakeClaimingImporter();
    let fakeClaims = false;
    const toggleableFake: FormatImporter = {
      ...fake,
      detect: async () => ({ claimed: fakeClaims, tables: [] })
    };
    const registry = new ImporterRegistry([new SimpleCsvImporter(), toggleableFake]);
    const mixedCatalog = new FileCatalog(mixedDir, registry);

    // Clean scan first: catalog populated, no conflict.
    await mixedCatalog.initialize();
    expect(mixedCatalog.getScanConflict()).toBeNull();
    expect(mixedCatalog.getAllTables()).toContain('hkquantitytypeidentifierheartrate');

    // A second format appears: refresh fails, catalog and loaded state kept,
    // conflict recorded with both display names.
    mixedCatalog.markLoaded('hkquantitytypeidentifierheartrate', 3);
    fakeClaims = true;
    await expect(mixedCatalog.refresh()).rejects.toThrow(MultipleFormatsError);

    const conflict = mixedCatalog.getScanConflict();
    expect(conflict?.formats).toEqual(['Simple Health Export CSV', 'Fake JSON Export']);
    expect(conflict?.message).toContain('separate directories');
    expect(mixedCatalog.getEntry('hkquantitytypeidentifierheartrate')?.loaded).toBe(true);

    // Removing the second format clears the conflict on the next scan.
    fakeClaims = false;
    await mixedCatalog.refresh();
    expect(mixedCatalog.getScanConflict()).toBeNull();

    rmSync(mixedDir, { recursive: true, force: true });
  });
});
