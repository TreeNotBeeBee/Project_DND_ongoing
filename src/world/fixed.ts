import { assert } from '../engine/dice';

export const AP_SCALE = 1_000_000;
export const HOUR_MS = 3_600_000;

/** Decimal conversion, including scientific notation, without binary-float rounding. */
export function micro(value: unknown, label = '行动力', signed = false): number {
  assert(typeof value === 'number' && Number.isFinite(value) && (signed || value >= 0), 'WORLD_NUMBER', `${label}必须为${signed ? '' : '非负'}有限数字`);
  const negative = value < 0;
  const [mantissa, exponent = '0'] = Math.abs(value).toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction), power = Number(exponent) + 6 - fraction.length;
  let result: bigint;
  if (power >= 0) result = digits * 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    assert(digits % divisor === 0n, 'WORLD_PRECISION', `${label}最多保留6位小数`);
    result = digits / divisor;
  }
  assert(result <= BigInt(Number.MAX_SAFE_INTEGER), 'WORLD_NUMBER', `${label}超出安全范围`);
  return Number(negative ? -result : result);
}
export function decimal(value: number): number {
  assert(Number.isSafeInteger(value), 'WORLD_NUMBER', '定点数超出安全范围');
  return value / AP_SCALE;
}
export function add(a: number, b: number): number { return decimal(micro(a, '数值', true) + micro(b, '数值', true)); }
export function scaledRatio(current: number, previousMaximum: number, maximum: number): number {
  const previous = micro(previousMaximum), next = micro(maximum), amount = micro(current);
  if (!previous) return 0;
  return decimal(Number(BigInt(Math.min(amount, previous)) * BigInt(next) / BigInt(previous)));
}
export function natural(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  assert(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max, 'WORLD_NUMBER', `${name}必须为0到${max}之间的整数`);
  return Number(value);
}
