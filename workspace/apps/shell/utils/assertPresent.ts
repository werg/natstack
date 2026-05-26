export function assertPresent<T>(value: T): NonNullable<T> {
  if (value == null) {
    throw new Error("Expected a defined value but received null/undefined.");
  }
  return value;
}
