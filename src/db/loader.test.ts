import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from './database';
import { FileCatalog } from './catalog';
import { TableLoader } from './loader';

const RECENT_ROWS = 120;
const OLD_ROWS = 5;

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

let dataDir: string;
let db: HealthDataDB;
let catalog: FileCatalog;
let loader: TableLoader;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'health-loader-test-'));

  // Quantity shape: has unit and numeric value
  const heartRateRows: string[] = [];
  for (let i = 0; i < RECENT_ROWS; i++) {
    const start = formatTimestamp(daysAgo(1 + (i % 60)));
    heartRateRows.push(
      `HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,${start},${start},count/min,${60 + (i % 40)}`
    );
  }
  for (let i = 0; i < OLD_ROWS; i++) {
    const start = formatTimestamp(daysAgo(200 + i));
    heartRateRows.push(
      `HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,${start},${start},count/min,${50 + i}`
    );
  }
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierHeartRate.csv',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value',
    heartRateRows
  );

  // Category shape: no unit column, value is a text label
  const stages = [
    'HKCategoryValueSleepAnalysisAsleepCore',
    'HKCategoryValueSleepAnalysisAsleepDeep',
    'HKCategoryValueSleepAnalysisAsleepREM',
    'HKCategoryValueSleepAnalysisInBed'
  ];
  const sleepRows: string[] = [];
  for (let i = 0; i < 40; i++) {
    const start = formatTimestamp(daysAgo(1 + (i % 30)));
    sleepRows.push(
      `HKCategoryTypeIdentifierSleepAnalysis,Apple Watch,10.0,Watch7,1,${start},${start},${stages[i % stages.length]}`
    );
  }
  for (let i = 0; i < OLD_ROWS; i++) {
    const start = formatTimestamp(daysAgo(200 + i));
    sleepRows.push(
      `HKCategoryTypeIdentifierSleepAnalysis,Apple Watch,10.0,Watch7,1,${start},${start},${stages[0]}`
    );
  }
  writeCsv(
    dataDir,
    'HKCategoryTypeIdentifierSleepAnalysis.csv',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,value',
    sleepRows
  );

  // Workout shape: no unit and no value column
  const workoutRows: string[] = [];
  for (let i = 0; i < 10; i++) {
    const start = formatTimestamp(daysAgo(1 + i));
    workoutRows.push(
      `HKWorkoutActivityTypeRunning,Apple Watch,10.0,${start},${start},${1800 + i},${400 + i},${5.5 + i}`
    );
  }
  writeCsv(
    dataDir,
    'HKWorkoutTypeIdentifierTest.csv',
    'type,sourceName,sourceVersion,startDate,endDate,duration,totalEnergyBurned,totalDistance',
    workoutRows
  );

  db = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
  await db.initialize();
  catalog = new FileCatalog(dataDir);
  await catalog.initialize();
  loader = new TableLoader(db, catalog);
});

afterAll(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('TableLoader quantity tables', () => {
  test('loads only rows inside the rolling window', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');

    const result = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierheartrate'
    );
    expect(Number(result[0].count)).toBe(RECENT_ROWS);
  });

  test('keeps a numeric value, a valueText copy, and the unit', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');

    const rows = await db.execute(`
      SELECT value, valueText, unit
      FROM hkquantitytypeidentifierheartrate
      LIMIT 1
    `);
    expect(typeof rows[0].value).toBe('number');
    expect(typeof rows[0].valueText).toBe('string');
    expect(rows[0].unit).toBe('count/min');

    const numeric = await db.execute(`
      SELECT AVG(value) as avg_value
      FROM hkquantitytypeidentifierheartrate
    `);
    expect(Number(numeric[0].avg_value)).toBeGreaterThan(0);
  });

  test('ensureTableLoaded is idempotent', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');

    const result = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierheartrate'
    );
    expect(Number(result[0].count)).toBe(RECENT_ROWS);
  });
});

describe('TableLoader category tables', () => {
  test('loads without error and preserves the stage label in valueText', async () => {
    await loader.ensureTableLoaded('hkcategorytypeidentifiersleepanalysis');

    const rows = await db.execute(`
      SELECT valueText, value
      FROM hkcategorytypeidentifiersleepanalysis
      WHERE valueText = 'HKCategoryValueSleepAnalysisAsleepDeep'
      LIMIT 1
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].valueText).toBe('HKCategoryValueSleepAnalysisAsleepDeep');
    expect(rows[0].value).toBeNull();
  });

  test('has no unit column', async () => {
    await loader.ensureTableLoaded('hkcategorytypeidentifiersleepanalysis');

    const columns = await db.execute(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'hkcategorytypeidentifiersleepanalysis'
    `);
    const names = columns.map((col: any) => String(col.column_name).toLowerCase());
    expect(names).not.toContain('unit');
    expect(names).toContain('valuetext');
  });
});

describe('TableLoader workout tables', () => {
  test('loads without error and keeps workout columns queryable', async () => {
    await loader.ensureTableLoaded('hkworkouttypeidentifiertest');

    const rows = await db.execute(`
      SELECT duration, totalEnergyBurned, totalDistance
      FROM hkworkouttypeidentifiertest
      ORDER BY startDate DESC
      LIMIT 1
    `);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].duration)).toBeGreaterThan(0);
    expect(Number(rows[0].totalEnergyBurned)).toBeGreaterThan(0);
    expect(Number(rows[0].totalDistance)).toBeGreaterThan(0);
  });

  test('has no value column', async () => {
    await loader.ensureTableLoaded('hkworkouttypeidentifiertest');

    const columns = await db.execute(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'hkworkouttypeidentifiertest'
    `);
    const names = columns.map((col: any) => String(col.column_name).toLowerCase());
    expect(names).not.toContain('value');
    expect(names).not.toContain('valuetext');
  });
});
