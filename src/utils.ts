export function jsonReplacer(key: string, value: any): any {
  if (Object(value) instanceof BigInt) {
    return BigInt.prototype.toString.call(value);
  }
  return value;
}
