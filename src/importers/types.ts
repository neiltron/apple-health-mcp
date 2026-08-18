import type { HealthDataDB } from '../db/database';

// Classification assigned at detection from the filename alone. `other` covers
// recognized identifier families whose row shape detection has not verified
// (e.g. HKWorkoutTypeIdentifier*); a kind must never assert a shape it hasn't
// seen.
export type TableKind = 'quantity' | 'category' | 'workout' | 'other';

export interface DetectedTable {
  // Canonical lowercase HK identifier, e.g. hkquantitytypeidentifierheartrate.
  tableName: string;
  path: string;
  kind: TableKind;
}

export interface DetectionResult {
  // True whenever this format's files are present, even if they yield zero
  // tables, so an empty-but-recognized export still claims its format.
  claimed: boolean;
  tables: DetectedTable[];
}

export interface FormatImporter {
  // Stable identity for registry bookkeeping and conflict messages.
  id: string;
  displayName: string;
  // Scan the directory without materializing anything into DuckDB.
  detect(dataDir: string): Promise<DetectionResult>;
  // Materialize one table in canonical shape; returns the stored row count.
  load(db: HealthDataDB, table: DetectedTable): Promise<number>;
}
