export function assertPresent<T>(value: T): NonNullable<T> {
  if (value == null) {
    throw new Error("Expected a defined value but received null/undefined.");
  }

  return value;
}

export function deleteDynamicProperty<T extends object>(target: T, key: PropertyKey): boolean {
  return Reflect.deleteProperty(target as Record<PropertyKey, unknown>, key);
}
