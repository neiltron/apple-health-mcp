import { runFormatConformance, type ConformanceExpectations } from '../../test-helpers/conformance';
import { SimpleCsvImporter } from './importer';
import {
  writeCsv,
  formatTimestamp,
  QUANTITY_HEADER,
  CATEGORY_HEADER,
  WORKOUT_HEADER
} from '../../test-helpers/csv-fixtures';

const VALID_ROWS = 6;
const OLD_ROW_YEAR = 2009;
const WORKOUT_SECONDS = 45 * 60;

function quantityRow(start: string, end: string, value: string): string {
  return `HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,${start},${end},count/min,${value}`;
}

function writeFixtures(dir: string): ConformanceExpectations {
  const stamp = (iso: string) => formatTimestamp(new Date(iso));

  const rows: string[] = [];
  for (let i = 0; i < VALID_ROWS - 1; i++) {
    const at = stamp(`2020-06-0${i + 1}T10:00:00Z`);
    rows.push(quantityRow(at, at, String(60 + i)));
  }
  // The decades-old row proves there is no date window.
  const old = stamp(`${OLD_ROW_YEAR}-03-15T08:00:00Z`);
  rows.push(quantityRow(old, old, '55'));
  // Non-numeric value: loads with numeric NULL, text preserved.
  const at = stamp('2020-06-20T10:00:00Z');
  rows.push(quantityRow(at, at, 'not-a-number'));
  // Unparseable startDate: excluded.
  rows.push(quantityRow('never oclock', at, '70'));
  // Empty value where the shape has a value column: excluded.
  rows.push(quantityRow(at, at, ''));
  // Unparseable endDate: still loads, endDate NULL.
  rows.push(quantityRow(stamp('2020-06-21T10:00:00Z'), 'never oclock', '71'));
  writeCsv(dir, 'HKQuantityTypeIdentifierHeartRate.csv', QUANTITY_HEADER, rows);

  const sleepAt = stamp('2020-06-01T00:30:00Z');
  const sleepEnd = stamp('2020-06-01T04:30:00Z');
  writeCsv(dir, 'HKCategoryTypeIdentifierSleepAnalysis.csv', CATEGORY_HEADER, [
    `HKCategoryTypeIdentifierSleepAnalysis,Apple Watch,10.0,Watch7,1,${sleepAt},${sleepEnd},HKCategoryValueSleepAnalysisAsleepCore`
  ]);

  const workoutStart = stamp('2020-06-02T17:00:00Z');
  const workoutEnd = stamp('2020-06-02T17:45:00Z');
  writeCsv(dir, 'HKWorkoutActivityTypeRunning.csv', WORKOUT_HEADER, [
    `HKWorkoutActivityTypeRunning,Apple Watch,10.0,${workoutStart},${workoutEnd},45,400,5.5`
  ]);

  // Every row has an unparseable startDate, so nothing survives the load.
  writeCsv(dir, 'HKQuantityTypeIdentifierStepCount.csv', QUANTITY_HEADER, [
    quantityRow('not-a-date', 'not-a-date', '7000')
  ]);

  // No startDate column at all: the load must fail and leave nothing behind.
  writeCsv(dir, 'HKQuantityTypeIdentifierBodyMass.csv', 'type,when,value', [
    'HKQuantityTypeIdentifierBodyMass,yesterday,80'
  ]);

  return {
    quantityTable: 'hkquantitytypeidentifierheartrate',
    validRows: VALID_ROWS,
    oldRowYear: OLD_ROW_YEAR,
    nonNumericValueText: 'not-a-number',
    categoryTable: 'hkcategorytypeidentifiersleepanalysis',
    categoryLabel: 'HKCategoryValueSleepAnalysisAsleepCore',
    workoutTable: 'hkworkoutactivitytyperunning',
    workoutColumn: 'totalEnergyBurned',
    workoutDurationSeconds: WORKOUT_SECONDS,
    emptyTable: 'hkquantitytypeidentifierstepcount',
    brokenTable: 'hkquantitytypeidentifierbodymass'
  };
}

runFormatConformance(new SimpleCsvImporter(), writeFixtures);
