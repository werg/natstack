export function isDev(): boolean {
  return process.env["NODE_ENV"] === "development";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
