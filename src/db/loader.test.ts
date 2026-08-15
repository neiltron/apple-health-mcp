import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from './database';
import { FileCatalog } from './catalog';
import { TableLoader } from './loader';

const RECENT_ROWS = 120;
const OLD_ROWS = 5;
const TOTAL_HEART_RATE_ROWS = RECENT_ROWS + OLD_ROWS;

// Fixed historical anchors keep every assertion independent of the current date.
const RECENT_ANCHOR = new Date('2020-06-01T00:00:00Z');
const OLD_ANCHOR = new Date('2019-01-15T00:00:00Z');

function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +0000`;
}

function daysAfter(anchor: Date, days: number): Date {
  const date = new Date(anchor);
  date.setDate(date.getDate() + days);
  return date;
}

function writeCsv(dir: string, fileName: string, header: string, rows: string[]): void {
  const lines = ['sep=,', header, ...rows];
  writeFileSync(join(dir, fileName), lines.join('\r\n') + '\r\n');
}

const QUANTITY_HEADER =
  'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value';
const CATEGORY_HEADER =
  'type,sourceName,sourceVersion,productType,device,startDate,endDate,value';

function quantityRow(start: string, value: number): string {
  return `HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,${start},${start},count/min,${value}`;
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
    const start = formatTimestamp(daysAfter(RECENT_ANCHOR, i % 60));
    heartRateRows.push(quantityRow(start, 60 + (i % 40)));
  }
  for (let i = 0; i < OLD_ROWS; i++) {
    const start = formatTimestamp(daysAfter(OLD_ANCHOR, i));
    heartRateRows.push(quantityRow(start, 50 + i));
  }
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierHeartRate.csv',
    QUANTITY_HEADER,
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
    const start = formatTimestamp(daysAfter(RECENT_ANCHOR, i % 30));
    sleepRows.push(
      `HKCategoryTypeIdentifierSleepAnalysis,Apple Watch,10.0,Watch7,1,${start},${start},${stages[i % stages.length]}`
    );
  }
  for (let i = 0; i < OLD_ROWS; i++) {
    const start = formatTimestamp(daysAfter(OLD_ANCHOR, i));
    sleepRows.push(
      `HKCategoryTypeIdentifierSleepAnalysis,Apple Watch,10.0,Watch7,1,${start},${start},HKCategoryValueSleepAnalysisAsleepDeep`
    );
  }
  writeCsv(
    dataDir,
    'HKCategoryTypeIdentifierSleepAnalysis.csv',
    CATEGORY_HEADER,
    sleepRows
  );

  // Workout shape: no unit and no value column
  const workoutRows: string[] = [];
  for (let i = 0; i < 10; i++) {
    const start = formatTimestamp(daysAfter(RECENT_ANCHOR, i));
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

  // Old-only shape: every row is years old
  const oldOnlyRows: string[] = [];
  for (let i = 0; i < 12; i++) {
    const start = formatTimestamp(daysAfter(OLD_ANCHOR, i));
    oldOnlyRows.push(
      `HKQuantityTypeIdentifierStepCount,iPhone,10.0,iPhone12,1,${start},${start},count,${1000 + i}`
    );
  }
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierStepCount.csv',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value',
    oldOnlyRows
  );

  // Mixed validity: valid old rows plus rows with unparseable or missing startDate
  const mixedRows: string[] = [];
  for (let i = 0; i < 4; i++) {
    const start = formatTimestamp(daysAfter(OLD_ANCHOR, i));
    mixedRows.push(
      `HKQuantityTypeIdentifierBodyMass,Withings,1.0,Scale,1,${start},${start},kg,${70 + i}`
    );
  }
  mixedRows.push(
    'HKQuantityTypeIdentifierBodyMass,Withings,1.0,Scale,1,not-a-date,not-a-date,kg,99'
  );
  mixedRows.push(
    'HKQuantityTypeIdentifierBodyMass,Withings,1.0,Scale,1,,,kg,98'
  );
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierBodyMass.csv',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value',
    mixedRows
  );

  // No survivable rows: every startDate is unparseable
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierRespiratoryRate.csv',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value',
    [
      'HKQuantityTypeIdentifierRespiratoryRate,Apple Watch,10.0,Watch7,1,bad,bad,count/min,12',
      'HKQuantityTypeIdentifierRespiratoryRate,Apple Watch,10.0,Watch7,1,also-bad,also-bad,count/min,13'
    ]
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
  test('loads every row regardless of age', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');

    const result = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierheartrate'
    );
    expect(Number(result[0].count)).toBe(TOTAL_HEART_RATE_ROWS);

    const oldest = await db.execute(`
      SELECT MIN(startDate) as earliest
      FROM hkquantitytypeidentifierheartrate
    `);
    expect(new Date(oldest[0].earliest).getUTCFullYear()).toBe(2019);
  });

  test('records the stored row count in the catalog', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');

    const entry = catalog.getEntry('hkquantitytypeidentifierheartrate');
    expect(entry?.loaded).toBe(true);
    expect(entry?.rowCount).toBe(TOTAL_HEART_RATE_ROWS);
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

  test('ensureTableLoaded is idempotent and preserves the full row count', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');

    const result = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierheartrate'
    );
    expect(Number(result[0].count)).toBe(TOTAL_HEART_RATE_ROWS);
    expect(catalog.getEntry('hkquantitytypeidentifierheartrate')?.rowCount).toBe(
      TOTAL_HEART_RATE_ROWS
    );
  });
});

describe('TableLoader category tables', () => {
  test('keeps every row including old sleep stages', async () => {
    await loader.ensureTableLoaded('hkcategorytypeidentifiersleepanalysis');

    const result = await db.execute(
      'SELECT COUNT(*) as count FROM hkcategorytypeidentifiersleepanalysis'
    );
    expect(Number(result[0].count)).toBe(40 + OLD_ROWS);

    const oldStage = await db.execute(`
      SELECT valueText, value
      FROM hkcategorytypeidentifiersleepanalysis
      WHERE startDate < TIMESTAMP '2019-06-01 00:00:00'
      ORDER BY startDate
      LIMIT 1
    `);
    expect(oldStage.length).toBe(1);
    expect(oldStage[0].valueText).toBe('HKCategoryValueSleepAnalysisAsleepDeep');
    expect(oldStage[0].value).toBeNull();
  });

  test('preserves the stage label in valueText with a null numeric value', async () => {
    await loader.ensureTableLoaded('hkcategorytypeidentifiersleepanalysis');

    const rows = await db.execute(`
      SELECT valueText, value
      FROM hkcategorytypeidentifiersleepanalysis
      WHERE valueText = 'HKCategoryValueSleepAnalysisAsleepREM'
      LIMIT 1
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].valueText).toBe('HKCategoryValueSleepAnalysisAsleepREM');
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

describe('TableLoader old-only tables', () => {
  test('marks the table loaded and returns the old rows', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierstepcount');

    const entry = catalog.getEntry('hkquantitytypeidentifierstepcount');
    expect(entry?.loaded).toBe(true);
    expect(entry?.rowCount).toBe(12);

    const rows = await db.execute(`
      SELECT COUNT(*) as count, MAX(startDate) as latest
      FROM hkquantitytypeidentifierstepcount
    `);
    expect(Number(rows[0].count)).toBe(12);
    expect(new Date(rows[0].latest).getUTCFullYear()).toBe(2019);
  });
});

describe('TableLoader date validation', () => {
  test('excludes rows with an invalid or missing startDate and keeps valid old rows', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierbodymass');

    const rows = await db.execute(`
      SELECT COUNT(*) as count
      FROM hkquantitytypeidentifierbodymass
    `);
    expect(Number(rows[0].count)).toBe(4);

    const invalid = await db.execute(`
      SELECT COUNT(*) as count
      FROM hkquantitytypeidentifierbodymass
      WHERE startDate IS NULL
    `);
    expect(Number(invalid[0].count)).toBe(0);
    expect(catalog.getEntry('hkquantitytypeidentifierbodymass')?.rowCount).toBe(4);
  });

  test('marks a table with no surviving rows as loaded and queryable', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierrespiratoryrate');

    const entry = catalog.getEntry('hkquantitytypeidentifierrespiratoryrate');
    expect(entry?.loaded).toBe(true);
    expect(entry?.rowCount).toBe(0);

    const rows = await db.execute(
      'SELECT * FROM hkquantitytypeidentifierrespiratoryrate'
    );
    expect(rows.length).toBe(0);

    // A second call must not rescan the CSV; the table stays present and empty.
    await loader.ensureTableLoaded('hkquantitytypeidentifierrespiratoryrate');
    const again = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierrespiratoryrate'
    );
    expect(Number(again[0].count)).toBe(0);
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
