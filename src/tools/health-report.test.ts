import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from '../db/database';
import { FileCatalog } from '../db/catalog';
import { TableLoader } from '../db/loader';
import { QueryCache } from '../core/cache';
import { HealthReportTool } from './health-report';

const SLEEP_NIGHTS = 10;
const ASLEEP_HOURS_PER_NIGHT = 8;
const IN_BED_HOURS_PER_NIGHT = 9;
const WORKOUT_MINUTES = 30;

function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +0000`;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

// Pin a time of day so every row for a night lands on the same calendar date.
function dayAt(days: number, hours: number, minutes: number = 0): Date {
  const date = daysAgo(days);
  date.setUTCHours(hours, minutes, 0, 0);
  return date;
}

function writeCsv(dir: string, fileName: string, header: string, rows: string[]): void {
  const lines = ['sep=,', header, ...rows];
  writeFileSync(join(dir, fileName), lines.join('\r\n') + '\r\n');
}

const QUANTITY_HEADER = 'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value';
const CATEGORY_HEADER = 'type,sourceName,sourceVersion,productType,device,startDate,endDate,value';
const WORKOUT_HEADER = 'type,sourceName,sourceVersion,startDate,endDate,duration,totalEnergyBurned,totalDistance';

function writeFixtures(dir: string, options: { heartRateOnly?: boolean } = {}): void {
  const heartRateRows: string[] = [];
  for (let day = 1; day <= 14; day++) {
    for (let i = 0; i < 6; i++) {
      const stamp = formatTimestamp(dayAt(day, 9 + i));
      heartRateRows.push(
        `HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,${stamp},${stamp},count/min,${60 + i * 3}`
      );
    }
  }
  writeCsv(dir, 'HKQuantityTypeIdentifierHeartRate.csv', QUANTITY_HEADER, heartRateRows);

  if (options.heartRateOnly) return;

  // Each night: three asleep stages summing to 8 hours (00:30-08:30) plus an
  // InBed row spanning 9 hours that the report must exclude.
  const sleepRows: string[] = [];
  for (let day = 1; day <= SLEEP_NIGHTS; day++) {
    const stages: Array<[string, number, number]> = [
      ['HKCategoryValueSleepAnalysisAsleepCore', 0, 4],
      ['HKCategoryValueSleepAnalysisAsleepDeep', 4, 6],
      ['HKCategoryValueSleepAnalysisAsleepREM', 6, 8]
    ];
    for (const [label, offsetStart, offsetEnd] of stages) {
      const start = formatTimestamp(dayAt(day, 0, 30 + offsetStart * 60));
      const end = formatTimestamp(dayAt(day, 0, 30 + offsetEnd * 60));
      sleepRows.push(
        `HKCategoryTypeIdentifierSleepAnalysis,Apple Watch,10.0,Watch7,1,${start},${end},${label}`
      );
    }
    const inBedStart = formatTimestamp(dayAt(day, 0, 0));
    const inBedEnd = formatTimestamp(dayAt(day, 0, IN_BED_HOURS_PER_NIGHT * 60));
    sleepRows.push(
      `HKCategoryTypeIdentifierSleepAnalysis,Apple Watch,10.0,Watch7,1,${inBedStart},${inBedEnd},HKCategoryValueSleepAnalysisInBed`
    );
  }
  writeCsv(dir, 'HKCategoryTypeIdentifierSleepAnalysis.csv', CATEGORY_HEADER, sleepRows);

  // Two per-type workout exports. The duration column holds minutes while the
  // timestamps span WORKOUT_MINUTES minutes, so a report that trusts duration
  // gets a wildly different total.
  for (const [file, type] of [
    ['HKWorkoutActivityTypeRunning.csv', 'HKWorkoutActivityTypeRunning'],
    ['HKWorkoutActivityTypeCycling.csv', 'HKWorkoutActivityTypeCycling']
  ]) {
    const rows: string[] = [];
    for (let day = 1; day <= 5; day++) {
      const start = formatTimestamp(dayAt(day, 17));
      const end = formatTimestamp(dayAt(day, 17, WORKOUT_MINUTES));
      rows.push(`${type},Apple Watch,10.0,${start},${end},${WORKOUT_MINUTES},400,5.5`);
    }
    writeCsv(dir, file, WORKOUT_HEADER, rows);
  }

  const stepRows: string[] = [];
  for (let day = 1; day <= 14; day++) {
    const stamp = formatTimestamp(dayAt(day, 12));
    stepRows.push(
      `HKQuantityTypeIdentifierStepCount,iPhone,18.0,iPhone15,1,${stamp},${stamp},count,${8000 + day * 10}`
    );
  }
  writeCsv(dir, 'HKQuantityTypeIdentifierStepCount.csv', QUANTITY_HEADER, stepRows);

  const activeRows: string[] = [];
  const basalRows: string[] = [];
  for (let day = 1; day <= 14; day++) {
    const stamp = formatTimestamp(dayAt(day, 13));
    activeRows.push(
      `HKQuantityTypeIdentifierActiveEnergyBurned,Apple Watch,10.0,Watch7,1,${stamp},${stamp},kcal,500`
    );
    basalRows.push(
      `HKQuantityTypeIdentifierBasalEnergyBurned,Apple Watch,10.0,Watch7,1,${stamp},${stamp},kcal,1600`
    );
  }
  writeCsv(dir, 'HKQuantityTypeIdentifierActiveEnergyBurned.csv', QUANTITY_HEADER, activeRows);
  writeCsv(dir, 'HKQuantityTypeIdentifierBasalEnergyBurned.csv', QUANTITY_HEADER, basalRows);
}

function sectionByTitle(report: any, title: string): any {
  return report.sections.find((section: any) => section.title === title);
}

let dataDir: string;
let db: HealthDataDB;
let report: any;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'health-report-test-'));
  writeFixtures(dataDir);

  // Cold server: nothing loaded before the report runs.
  db = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
  await db.initialize();
  const catalog = new FileCatalog(dataDir);
  await catalog.initialize();
  const loader = new TableLoader(db, catalog);
  const cache = new QueryCache(100);

  const reportTool = new HealthReportTool(db, cache, catalog, loader);
  report = await reportTool.execute({ report_type: 'weekly' });
});

afterAll(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('HealthReportTool on a cold server', () => {
  test('returns every section without a prior query', () => {
    const titles = report.sections.map((section: any) => section.title);
    expect(titles).toEqual(['Heart Rate', 'Activity', 'Sleep', 'Workouts', 'Calories']);
    expect(report.summary.length).toBeGreaterThan(0);
  });

  test('reports plausible heart rate numbers', () => {
    const data = sectionByTitle(report, 'Heart Rate').data;
    expect(Number(data.average)).toBeGreaterThan(50);
    expect(Number(data.average)).toBeLessThan(120);
    expect(Number(data.totalReadings)).toBeGreaterThan(0);
    expect(Number(data.daysWithData)).toBe(7);
  });

  test('reports plausible activity numbers', () => {
    const data = sectionByTitle(report, 'Activity').data;
    expect(Number(data.activeDays)).toBe(7);
    expect(Number(data.averageDailySteps)).toBeGreaterThan(1000);
    expect(Number(data.totalSteps)).toBeGreaterThan(Number(data.averageDailySteps));
  });

  test('reports plausible calorie numbers', () => {
    const data = sectionByTitle(report, 'Calories').data;
    expect(Number(data.averageActiveCalories)).toBe(500);
    expect(Number(data.averageBasalCalories)).toBe(1600);
    expect(Number(data.averageTotalCalories)).toBe(2100);
  });
});

describe('HealthReportTool sleep', () => {
  test('sums asleep stage durations from timestamps', () => {
    const data = sectionByTitle(report, 'Sleep').data;
    expect(Number(data.averageHours)).toBeCloseTo(ASLEEP_HOURS_PER_NIGHT, 1);
    expect(Number(data.nightsTracked)).toBe(7);
  });

  test('excludes InBed rows', () => {
    const data = sectionByTitle(report, 'Sleep').data;
    expect(Number(data.averageHours)).not.toBeCloseTo(IN_BED_HOURS_PER_NIGHT, 1);
    expect(Number(data.maximumHours)).toBeCloseTo(ASLEEP_HOURS_PER_NIGHT, 1);
  });
});

describe('HealthReportTool workouts', () => {
  test('aggregates across every per-type workout table', () => {
    const data = sectionByTitle(report, 'Workouts').data;
    expect(Number(data.totalWorkouts)).toBe(10);
    expect(Number(data.workoutTypes)).toBe(2);
    expect(Number(data.totalCalories)).toBe(4000);
  });

  test('derives hours from timestamps, not the duration column', () => {
    const data = sectionByTitle(report, 'Workouts').data;
    const expectedHours = (10 * WORKOUT_MINUTES * 60) / 3600;
    expect(Number(data.totalHours)).toBeCloseTo(expectedHours, 1);
    // Reading the duration column as seconds would give 0.1 hours.
    expect(Number(data.totalHours)).not.toBeCloseTo((10 * WORKOUT_MINUTES) / 3600, 1);
  });
});

describe('HealthReportTool with a missing metric', () => {
  test('says so instead of dropping the section', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'health-report-empty-'));
    writeFixtures(emptyDir, { heartRateOnly: true });

    const emptyDb = new HealthDataDB({ dataDir: emptyDir, maxMemoryMB: 512 });
    await emptyDb.initialize();
    const catalog = new FileCatalog(emptyDir);
    await catalog.initialize();
    const loader = new TableLoader(emptyDb, catalog);
    const reportTool = new HealthReportTool(emptyDb, new QueryCache(100), catalog, loader);

    const result = await reportTool.execute({
      report_type: 'weekly',
      include_metrics: ['workouts']
    });

    expect(result.sections.length).toBe(1);
    expect(result.sections[0].title).toBe('Workouts');
    expect(result.sections[0].summary).toBe('No workouts data available');

    await emptyDb.close();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
