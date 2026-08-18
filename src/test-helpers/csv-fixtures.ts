import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Simple Health Export CSV dialect: a literal `sep=,` first line, CRLF line
// endings, and a trailing newline. Loader options (skip = 1, new_line) depend
// on this exact shape, so every fixture goes through this one writer.
export function writeCsv(dir: string, fileName: string, header: string, rows: string[]): void {
  const lines = ['sep=,', header, ...rows];
  writeFileSync(join(dir, fileName), lines.join('\r\n') + '\r\n');
}

export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +0000`;
}

export function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export function daysAfter(anchor: Date, days: number): Date {
  const date = new Date(anchor);
  date.setDate(date.getDate() + days);
  return date;
}

export const QUANTITY_HEADER =
  'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value';
export const CATEGORY_HEADER =
  'type,sourceName,sourceVersion,productType,device,startDate,endDate,value';
export const WORKOUT_HEADER =
  'type,sourceName,sourceVersion,startDate,endDate,duration,totalEnergyBurned,totalDistance';
