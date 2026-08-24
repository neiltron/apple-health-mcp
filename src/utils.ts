export function jsonReplacer(key: string, value: any): any {
  if (Object(value) instanceof BigInt && Object(value) !== value) {
    return BigInt.prototype.toString.call(value);
  }
  return value;
}
