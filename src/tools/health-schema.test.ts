import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from '../db/database';
import { FileCatalog } from '../db/catalog';
import { defaultRegistry } from '../importers';
import { TableLoader } from '../db/loader';
import { HealthSchemaTool } from './health-schema';
import { writeCsv, formatTimestamp, daysAgo } from '../test-helpers/csv-fixtures';

const RECENT_HEART_RATE_ROWS = 120;
const OLD_HEART_RATE_ROWS = 5;
const TOTAL_HEART_RATE_ROWS = RECENT_HEART_RATE_ROWS + OLD_HEART_RATE_ROWS;

// A fixed historical date proves the loader cannot depend on the wall clock.
const OLD_EXPORT_DATE = new Date('2019-04-08T07:15:00Z');

let dataDir: string;
let db: HealthDataDB;
let catalog: FileCatalog;
let loader: TableLoader;
let schema: any;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'health-schema-test-'));

  const heartRateRows: string[] = [];
  for (let i = 0; i < RECENT_HEART_RATE_ROWS; i++) {
    const start = formatTimestamp(daysAgo(1 + (i % 60)));
    heartRateRows.push(
      `HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,${start},${start},count/min,${60 + (i % 40)}`
    );
  }
  for (let i = 0; i < OLD_HEART_RATE_ROWS; i++) {
    const old = new Date(OLD_EXPORT_DATE);
    old.setUTCDate(old.getUTCDate() + i);
    const start = formatTimestamp(old);
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
  writeCsv(
    dataDir,
    'HKCategoryTypeIdentifierSleepAnalysis.csv',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,value',
    sleepRows
  );

  db = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
  await db.initialize();
  catalog = new FileCatalog(dataDir, defaultRegistry());
  await catalog.initialize();
  loader = new TableLoader(db, catalog);

  const schemaTool = new HealthSchemaTool(db, catalog, loader);
  schema = await schemaTool.execute();
});

afterAll(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('HealthSchemaTool', () => {
  test('loads every row, not a 100 row sample', async () => {
    const result = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierheartrate'
    );
    expect(Number(result[0].count)).toBe(TOTAL_HEART_RATE_ROWS);
  });

  test('reports the full row count and an earliest date years in the past', () => {
    const stats = schema.tableDetails['hkquantitytypeidentifierheartrate'].statistics;
    expect(Number(stats.total_rows)).toBe(TOTAL_HEART_RATE_ROWS);

    const earliest = new Date(String(stats.earliest_date)).getTime();
    expect(earliest).toBe(Date.UTC(2019, 3, 8));
  });

  test('records the real row count in the catalog', () => {
    const entry = catalog.getEntry('hkquantitytypeidentifierheartrate');
    expect(entry?.loaded).toBe(true);
    expect(Number(entry?.rowCount)).toBe(TOTAL_HEART_RATE_ROWS);
  });

  test('reports the primary unit for a quantity table', () => {
    const details = schema.tableDetails['hkquantitytypeidentifierheartrate'];
    expect(details.error).toBeUndefined();
    expect(details.primaryUnit).toBe('count/min');
  });

  test('handles a category table with no unit column', () => {
    const details = schema.tableDetails['hkcategorytypeidentifiersleepanalysis'];
    expect(details.error).toBeUndefined();
    expect(details.primaryUnit).toBe('unknown');
    expect(details.units).toEqual([]);

    const columnNames = details.columns.map((col: any) => String(col.name).toLowerCase());
    expect(columnNames).toContain('valuetext');
    expect(columnNames).not.toContain('unit');
  });

  test('leaves tables with no unit out of the unit reference', () => {
    expect(schema.unitReference['hkquantitytypeidentifierheartrate']).toBe('count/min');
    expect(schema.unitReference['hkcategorytypeidentifiersleepanalysis']).toBeUndefined();
  });

  test('tells the client about valueText', () => {
    expect(schema.queryTips.some((tip: string) => tip.includes('valueText'))).toBe(true);
  });

  test('reports tables in memory instead of a misleading loaded count', () => {
    expect(schema.summary.loadedTables).toBeUndefined();
    expect(schema.summary.tablesInMemory).toBeGreaterThan(0);
    expect(schema.summary.loadingNote).toContain('on demand');
  });
});

describe('HealthSchemaTool with an old-only export', () => {
  let oldDir: string;
  let oldDb: HealthDataDB;
  let oldSchema: any;

  beforeAll(async () => {
    oldDir = mkdtempSync(join(tmpdir(), 'health-schema-old-'));

    const rows: string[] = [];
    for (let i = 0; i < 20; i++) {
      const stamp = new Date(OLD_EXPORT_DATE);
      stamp.setUTCDate(stamp.getUTCDate() + i);
      const start = formatTimestamp(stamp);
      rows.push(
        `HKQuantityTypeIdentifierStepCount,iPhone,18.0,iPhone15,1,${start},${start},count,${7000 + i}`
      );
    }
    writeCsv(
      oldDir,
      'HKQuantityTypeIdentifierStepCount.csv',
      'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value',
      rows
    );

    oldDb = new HealthDataDB({ dataDir: oldDir, maxMemoryMB: 512 });
    await oldDb.initialize();
    const oldCatalog = new FileCatalog(oldDir, defaultRegistry());
    await oldCatalog.initialize();
    const oldLoader = new TableLoader(oldDb, oldCatalog);

    oldSchema = await new HealthSchemaTool(oldDb, oldCatalog, oldLoader).execute();
  });

  afterAll(async () => {
    await oldDb.close();
    rmSync(oldDir, { recursive: true, force: true });
  });

  test('makes a table whose rows are all years old available', () => {
    const details = oldSchema.tableDetails['hkquantitytypeidentifierstepcount'];
    expect(details.available).toBeUndefined();
    expect(details.note).toBeUndefined();
    expect(details.error).toBeUndefined();
    expect(Number(details.statistics.total_rows)).toBe(20);
  });
});

describe('HealthSchemaTool with an unreadable export', () => {
  let emptyDir: string;
  let emptyDb: HealthDataDB;
  let emptySchema: any;

  beforeAll(async () => {
    emptyDir = mkdtempSync(join(tmpdir(), 'health-schema-empty-'));

    // Every row has an unparseable startDate, so nothing survives staging.
    writeCsv(
      emptyDir,
      'HKQuantityTypeIdentifierStepCount.csv',
      'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value',
      ['HKQuantityTypeIdentifierStepCount,iPhone,18.0,iPhone15,1,not-a-date,not-a-date,count,7000']
    );

    emptyDb = new HealthDataDB({ dataDir: emptyDir, maxMemoryMB: 512 });
    await emptyDb.initialize();
    const emptyCatalog = new FileCatalog(emptyDir, defaultRegistry());
    await emptyCatalog.initialize();
    const emptyLoader = new TableLoader(emptyDb, emptyCatalog);

    emptySchema = await new HealthSchemaTool(emptyDb, emptyCatalog, emptyLoader).execute();
  });

  afterAll(async () => {
    await emptyDb.close();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test('gives a neutral note that does not blame a date window', () => {
    const details = emptySchema.tableDetails['hkquantitytypeidentifierstepcount'];
    expect(details.note).toBe('no rows loaded from this file (unparseable dates or empty values)');
    expect(details.note).not.toContain('90');
    expect(details.note).not.toContain('window');
  });
});

describe('HealthSchemaTool rescan', () => {
  test('finds a workout export written after the first execute', async () => {
    expect(schema.availableTables).not.toContain('hkworkoutactivitytyperunning');

    const workoutRows: string[] = [];
    for (let i = 0; i < 10; i++) {
      const start = formatTimestamp(daysAgo(1 + i));
      workoutRows.push(
        `HKWorkoutActivityTypeRunning,Apple Watch,10.0,${start},${start},${1800 + i},${400 + i},${5.5 + i}`
      );
    }
    writeCsv(
      dataDir,
      'HKWorkoutActivityTypeRunning.csv',
      'type,sourceName,sourceVersion,startDate,endDate,duration,totalEnergyBurned,totalDistance',
      workoutRows
    );

    const schemaTool = new HealthSchemaTool(db, catalog, loader);
    const rescanned = await schemaTool.execute();

    expect(rescanned.availableTables).toContain('hkworkoutactivitytyperunning');
    expect(rescanned.commonPatterns.workouts).toContain('hkworkoutactivitytyperunning');

    // The workout CSV has no unit and no value column. It should still load.
    const details = rescanned.tableDetails['hkworkoutactivitytyperunning'];
    expect(details.error).toBeUndefined();
    expect(details.primaryUnit).toBe('unknown');

    const rows = await db.execute(`
      SELECT duration, totalDistance
      FROM hkworkoutactivitytyperunning
      LIMIT 1
    `);
    expect(Number(rows[0].duration)).toBeGreaterThan(0);
  });
});
