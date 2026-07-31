import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from '../db/database';
import { FileCatalog } from '../db/catalog';
import { TableLoader } from '../db/loader';
import { HealthSchemaTool } from './health-schema';

const RECENT_HEART_RATE_ROWS = 120;

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
  for (let i = 0; i < 5; i++) {
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
  catalog = new FileCatalog(dataDir);
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
  test('loads the full rolling window, not a 100 row sample', async () => {
    const result = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierheartrate'
    );
    expect(Number(result[0].count)).toBe(RECENT_HEART_RATE_ROWS);
  });

  test('records the real row count in the catalog', () => {
    const entry = catalog.getEntry('hkquantitytypeidentifierheartrate');
    expect(entry?.loaded).toBe(true);
    expect(Number(entry?.rowCount)).toBe(RECENT_HEART_RATE_ROWS);
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
