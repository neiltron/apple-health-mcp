// Escape a string for use inside a single-quoted SQL literal. Paths and
// directory names can contain a quote ("Neil's Health"); doubling it keeps the
// value inside its literal. Used for interpolating file paths and the data
// directory into DuckDB statements that have no parameter binding.
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function jsonReplacer(key: string, value: any): any {
  if (Object(value) instanceof BigInt && Object(value) !== value) {
    return BigInt.prototype.toString.call(value);
  }
  return value;
}
