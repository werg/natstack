export class Session {
  connect(): void {
    throw new Error("Node inspector is not available in workspace panels");
  }

  disconnect(): void {
    // no-op
  }

  post(): void {
    throw new Error("Node inspector is not available in workspace panels");
  }
}

export function url(): undefined {
  return undefined;
}

export default { Session, url };
