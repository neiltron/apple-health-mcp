import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCatalog } from './catalog';

function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +0000`;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function writeCsv(dir: string, fileName: string, header: string, rows: string[]): void {
  const lines = ['sep=,', header, ...rows];
  writeFileSync(join(dir, fileName), lines.join('\r\n') + '\r\n');
}

const QUANTITY_HEADER =
  'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value';
const WORKOUT_HEADER =
  'type,sourceName,sourceVersion,startDate,endDate,duration,totalEnergyBurned,totalDistance';

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

  catalog = new FileCatalog(dataDir);
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

  test('ignores files that are not health exports', () => {
    const tables = catalog.getAllTables();
    expect(tables).not.toContain('notes');
    expect(tables).not.toContain('workout');
  });
});

describe('FileCatalog refresh', () => {
  test('picks up a file written after initialize', async () => {
    const lateDir = mkdtempSync(join(tmpdir(), 'health-catalog-late-'));
    const lateCatalog = new FileCatalog(lateDir);
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

    const goneCatalog = new FileCatalog(goneDir);
    await goneCatalog.initialize();
    goneCatalog.markLoaded('hkquantitytypeidentifierheartrate', 7);

    rmSync(join(goneDir, 'HKQuantityTypeIdentifierHeartRate.csv'));
    await goneCatalog.refresh();

    const entry = goneCatalog.getEntry('hkquantitytypeidentifierheartrate');
    expect(entry?.loaded).toBe(true);
    expect(entry?.rowCount).toBe(7);
    rmSync(goneDir, { recursive: true, force: true });
  });
});
