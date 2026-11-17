/** JSON-safe integer upper bound (2^53 - 1). */
export const JSON_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER; // 9007199254740991

export function isJsonSafeNonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isJsonSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0);
}

/** Fail-closed checked arithmetic for CORE-001.v3 scoring/turns. */
export function checkedNonNegAdd(
  left: number,
  right: number,
  onOverflow: () => void,
): number {
  if (left < 0 || right < 0 || !Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    onOverflow();
    return 0;
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0 || sum > JSON_MAX_SAFE_INTEGER) {
    onOverflow();
    return 0;
  }
  return sum;
}

export function checkedNonNegMul(
  left: number,
  right: number,
  onOverflow: () => void,
): number {
  if (left < 0 || right < 0 || !Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    onOverflow();
    return 0;
  }
  if (left === 0 || right === 0) return 0;
  const product = left * right;
  if (!Number.isSafeInteger(product) || product < 0 || product > JSON_MAX_SAFE_INTEGER) {
    onOverflow();
    return 0;
  }
  if (Math.trunc(product / right) !== left) {
    onOverflow();
    return 0;
  }
  return product;
}
