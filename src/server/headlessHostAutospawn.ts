export function resolveHeadlessHostAutospawn(input: {
  cliValue?: boolean;
  envValue?: string;
}): boolean {
  if (input.cliValue !== undefined) return input.cliValue;
  if (input.envValue !== undefined) return input.envValue === "1" || input.envValue === "true";
  return true;
}
