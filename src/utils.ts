function isBigInt(value: any): value is bigint {
  return Object.prototype.toString.call(value) === '[object BigInt]';
}

export function jsonReplacer(key: string, value: any): any {
  if (isBigInt(value)) {
    return value.toString();
  }
  return value;
} 