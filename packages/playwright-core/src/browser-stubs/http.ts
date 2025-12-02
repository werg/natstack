const notAvailable = () => {
  throw new Error('http is not available in the browser bundle');
};

// Stub Agent class for code that extends it (e.g., HappyEyeballs)
// This allows the class definition to work, even though it can't be used
export class Agent {
  constructor(_options?: any) {}
  createConnection(_options: any, _callback?: any): any {
    throw new Error('http.Agent is not available in the browser bundle');
  }
  destroy(): void {}
}

export default { Agent };
export const request = notAvailable;
export const get = notAvailable;
