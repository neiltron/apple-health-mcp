import { describe, expect, test } from 'bun:test';
import { jsonReplacer } from './utils';

describe('jsonReplacer', () => {
  test('serializes bigint values', () => {
    expect(JSON.stringify({ count: 12n }, jsonReplacer)).toBe('{"count":"12"}');
  });

  test('does not mistake a spoofed type tag for a bigint', () => {
    const tagged = { [Symbol.toStringTag]: 'BigInt', count: 12 };

    expect(jsonReplacer('value', tagged)).toBe(tagged);
  });

  test('preserves boxed bigint values', () => {
    const boxed = Object(12n);

    expect(jsonReplacer('value', boxed)).toBe(boxed);
  });
});
