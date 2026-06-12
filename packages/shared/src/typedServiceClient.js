/**
 * Runtime companion for typedServiceClient.ts.
 *
 * Some extension child processes load @natstack/shared source through Node's
 * native TS loader. That loader resolves literal relative ".js" specifiers
 * against the filesystem and does not rewrite them to ".ts". Keep this file
 * in sync with the runtime helpers in typedServiceClient.ts so imports such as
 * "../typedServiceClient.js" work in both bundled TS and direct Node ESM paths.
 */

export function defineServiceMethods(methods) {
  return methods;
}

export function createTypedServiceClient(service, methods, call) {
  const root = {};
  for (const fullName of Object.keys(methods)) {
    const segments = fullName.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = (node[segment] ??= {});
      if (typeof next !== "object" || next === null) {
        throw new Error(
          `Service "${service}" method "${fullName}" collides with non-group method "${segment}"`
        );
      }
      node = next;
    }
    const leaf = segments[segments.length - 1];
    if (node[leaf] !== undefined) {
      throw new Error(`Service "${service}" method "${fullName}" collides with group "${leaf}"`);
    }
    node[leaf] = (...args) => call(service, fullName, args);
  }
  return root;
}
