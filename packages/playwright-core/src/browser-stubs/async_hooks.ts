export class AsyncLocalStorage<T> {
  private _value: T | undefined;
  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R {
    this._value = store;
    return callback(...args);
  }
  getStore(): T | undefined {
    return this._value;
  }
  exit<R>(callback: (...args: any[]) => R, ...args: any[]): R {
    return callback(...args);
  }
}
export default { AsyncLocalStorage };
