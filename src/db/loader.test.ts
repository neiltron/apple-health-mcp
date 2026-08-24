import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from './database';
import { FileCatalog } from './catalog';
import { defaultRegistry } from '../importers';
import { TableLoader } from './loader';
import {
  writeCsv,
  formatTimestamp,
  daysAfter,
  QUANTITY_HEADER,
  CATEGORY_HEADER
} from '../test-helpers/csv-fixtures';

const RECENT_ROWS = 120;
const OLD_ROWS = 5;
const TOTAL_HEART_RATE_ROWS = RECENT_ROWS + OLD_ROWS;

// More numeric-looking rows than the sniffer's default ~20,480-row sample, so
// the type-drift fixture only loads fully when the whole file is sniffed.
const DRIFT_NUMERIC_ROWS = 21_000;
const DRIFT_TEXT_ROWS = 500;

// Fixed historical anchors keep every assertion independent of the current
// date. The old anchor sits decades back so even a generous re-added
// wall-clock window would fail these tests, not just a 90-day one.
const RECENT_ANCHOR = new Date('2020-06-01T00:00:00Z');
const OLD_ANCHOR = new Date('2010-01-15T00:00:00Z');

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

  // Withings-style shape: metadata columns whose header names contain spaces
  const withingsRows: string[] = [];
  for (let i = 0; i < 3; i++) {
    const start = formatTimestamp(daysAfter(OLD_ANCHOR, i));
    withingsRows.push(
      `HKQuantityTypeIdentifierHeight,Withings,8070102,"iPhone17,1",1,${start},${start},cm,${180 + i},5.2.1,12345`
    );
  }
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierHeight.csv',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value,Health Mate App Version,Withings User Identifier',
    withingsRows
  );

  // No startDate column at all: not a loadable health export shape
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierNoDates.csv',
    'type,sourceName,unit,value',
    ['HKQuantityTypeIdentifierNoDates,Manual,count,1']
  );

  // Type-drift shape: sourceVersion looks numeric ("10.5") for more rows than
  // the CSV sniffer samples by default (~20k), then turns non-numeric
  // ("11.0.1"). A sampled type guess makes every later row a CAST error that
  // ignore_errors silently drops.
  const driftRows: string[] = [];
  for (let i = 0; i < DRIFT_NUMERIC_ROWS; i++) {
    const start = formatTimestamp(daysAfter(RECENT_ANCHOR, i % 90));
    driftRows.push(
      `HKQuantityTypeIdentifierVO2Max,Apple Watch,10.5,Watch7,1,${start},${start},mL/min·kg,${35 + (i % 10)}`
    );
  }
  for (let i = 0; i < DRIFT_TEXT_ROWS; i++) {
    const start = formatTimestamp(daysAfter(RECENT_ANCHOR, 90 + (i % 30)));
    driftRows.push(
      `HKQuantityTypeIdentifierVO2Max,Apple Watch,11.0.1,Watch7,1,${start},${start},mL/min·kg,${40 + (i % 10)}`
    );
  }
  writeCsv(
    dataDir,
    'HKQuantityTypeIdentifierVO2Max.csv',
    QUANTITY_HEADER,
    driftRows
  );

  db = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
  await db.initialize();
  catalog = new FileCatalog(dataDir, defaultRegistry());
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
    expect(new Date(oldest[0].earliest).getUTCFullYear()).toBe(2010);
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
    expect(rows[0].value).toBe(60);
    expect(rows[0].valueText).toBe('60');
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

describe('TableLoader staging', () => {
  test('materializes no staging table for any loaded shape', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheartrate');
    await loader.ensureTableLoaded('hkcategorytypeidentifiersleepanalysis');
    await loader.ensureTableLoaded('hkworkouttypeidentifiertest');
    await loader.ensureTableLoaded('hkquantitytypeidentifierrespiratoryrate');

    const leftovers = await db.execute(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name LIKE '%_staging'
    `);
    expect(leftovers.length).toBe(0);
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
      WHERE startDate < TIMESTAMP '2010-06-01 00:00:00'
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
    expect(new Date(rows[0].latest).getUTCFullYear()).toBe(2010);
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

describe('TableLoader shape validation', () => {
  test('rejects a CSV without a startDate column and leaves no table behind', async () => {
    await expect(
      loader.ensureTableLoaded('hkquantitytypeidentifiernodates')
    ).rejects.toThrow('no startDate column');

    expect(catalog.getEntry('hkquantitytypeidentifiernodates')?.loaded).toBe(false);
    const tables = await db.execute(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'hkquantitytypeidentifiernodates'
    `);
    expect(tables.length).toBe(0);
  });
});

describe('TableLoader type sniffing', () => {
  test('keeps every row when a metadata column changes type past the sample window', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifiervo2max');

    const rows = await db.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifiervo2max'
    );
    expect(Number(rows[0].count)).toBe(DRIFT_NUMERIC_ROWS + DRIFT_TEXT_ROWS);

    // The rows after the drift are the ones a sampled type guess would drop.
    const lateRows = await db.execute(`
      SELECT COUNT(*) as count
      FROM hkquantitytypeidentifiervo2max
      WHERE sourceVersion = '11.0.1'
    `);
    expect(Number(lateRows[0].count)).toBe(DRIFT_TEXT_ROWS);
  });
});

describe('TableLoader header handling', () => {
  test('loads a CSV whose metadata column names contain spaces', async () => {
    await loader.ensureTableLoaded('hkquantitytypeidentifierheight');

    const entry = catalog.getEntry('hkquantitytypeidentifierheight');
    expect(entry?.loaded).toBe(true);
    expect(entry?.rowCount).toBe(3);

    const rows = await db.execute(`
      SELECT value, "Health Mate App Version" as appVersion
      FROM hkquantitytypeidentifierheight
      ORDER BY startDate
      LIMIT 1
    `);
    expect(Number(rows[0].value)).toBe(180);
    expect(String(rows[0].appVersion)).toBe('5.2.1');
  });
});

describe('TableLoader path handling', () => {
  test('loads from a directory whose name contains a quote', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'health-loader-quote-'));
    const quotedDir = join(parent, "Neil's Health");
    mkdirSync(quotedDir);
    writeCsv(
      quotedDir,
      'HKQuantityTypeIdentifierBodyMass.csv',
      QUANTITY_HEADER,
      [
        `HKQuantityTypeIdentifierBodyMass,Withings,1.0,Scale,1,${formatTimestamp(OLD_ANCHOR)},${formatTimestamp(OLD_ANCHOR)},kg,70`
      ]
    );

    const quotedDb = new HealthDataDB({ dataDir: quotedDir, maxMemoryMB: 512 });
    await quotedDb.initialize();
    const quotedCatalog = new FileCatalog(quotedDir, defaultRegistry());
    await quotedCatalog.initialize();
    const quotedLoader = new TableLoader(quotedDb, quotedCatalog);

    try {
      await quotedLoader.ensureTableLoaded('hkquantitytypeidentifierbodymass');
      const rows = await quotedDb.execute(
        'SELECT COUNT(*) as count FROM hkquantitytypeidentifierbodymass'
      );
      expect(Number(rows[0].count)).toBe(1);
    } finally {
      await quotedDb.close();
      rmSync(parent, { recursive: true, force: true });
    }
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

// Kept last in the file: the rescan test corrupts a fixture CSV on disk.
describe('TableLoader load mechanics', () => {
  let spyDb: HealthDataDB;
  let spyCatalog: FileCatalog;
  let spyLoader: TableLoader;
  const statements: string[] = [];

  beforeAll(async () => {
    spyDb = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
    await spyDb.initialize();
    spyCatalog = new FileCatalog(dataDir, defaultRegistry());
    await spyCatalog.initialize();
    spyLoader = new TableLoader(spyDb, spyCatalog);

    const originalRun = spyDb.run.bind(spyDb);
    const originalExecute = spyDb.execute.bind(spyDb);
    spyDb.run = (query: string, sessionId?: string) => {
      statements.push(query);
      return originalRun(query, sessionId);
    };
    spyDb.execute = (query: string, sessionId?: string) => {
      statements.push(query);
      return originalExecute(query, sessionId);
    };
  });

  afterAll(async () => {
    await spyDb.close();
  });

  test('loads in one pass: a single CREATE TABLE, no staging, no date literal', async () => {
    statements.length = 0;
    await spyLoader.ensureTableLoaded('hkquantitytypeidentifierheartrate');

    const creates = statements.filter((sql) => /CREATE TABLE/i.test(sql));
    expect(creates.length).toBe(1);
    expect(creates[0]).toContain('read_csv');
    expect(creates[0]).toContain('IS NOT NULL');
    // No wall-clock window: the load never compares startDate to a literal.
    expect(creates[0]).not.toMatch(/TIMESTAMP\)\s*[<>=]/);
    expect(statements.some((sql) => /_staging/i.test(sql))).toBe(false);
  });

  test('does not rescan the CSV once a table is loaded', async () => {
    await spyLoader.ensureTableLoaded('hkquantitytypeidentifierstepcount');
    const before = await spyDb.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierstepcount'
    );

    // A second call must be served from the loaded table. If it re-read the
    // file, this corrupted content would error or change the count.
    writeFileSync(join(dataDir, 'HKQuantityTypeIdentifierStepCount.csv'), 'garbage');
    await spyLoader.ensureTableLoaded('hkquantitytypeidentifierstepcount');

    const after = await spyDb.execute(
      'SELECT COUNT(*) as count FROM hkquantitytypeidentifierstepcount'
    );
    expect(Number(after[0].count)).toBe(Number(before[0].count));
    expect(Number(after[0].count)).toBe(12);
  });
});
