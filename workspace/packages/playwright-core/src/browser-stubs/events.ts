export class EventEmitter {
  static defaultMaxListeners = 10;
  private _listeners = new Map<string | symbol, Set<(...args: any[]) => void>>();
  private _maxListeners = 10;

  on(event: string | symbol, listener: (...args: any[]) => void) {
    return this.addListener(event, listener);
  }
  addListener(event: string | symbol, listener: (...args: any[]) => void) {
    if (!this._listeners.has(event))
      this._listeners.set(event, new Set());
    this._listeners.get(event)!.add(listener);
    return this;
  }
  once(event: string | symbol, listener: (...args: any[]) => void) {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.addListener(event, wrapper);
  }
  off(event: string | symbol, listener: (...args: any[]) => void) {
    return this.removeListener(event, listener);
  }
  removeListener(event: string | symbol, listener: (...args: any[]) => void) {
    this._listeners.get(event)?.delete(listener);
    return this;
  }
  removeAllListeners(event?: string | symbol) {
    if (event === undefined)
      this._listeners.clear();
    else
      this._listeners.delete(event);
    return this;
  }
  emit(event: string | symbol, ...args: any[]) {
    const set = this._listeners.get(event);
    if (!set)
      return false;
    for (const listener of Array.from(set))
      listener(...args);
    return true;
  }
  setMaxListeners(n: number) {
    this._maxListeners = n;
    return this;
  }
  getMaxListeners() {
    return this._maxListeners;
  }
  listenerCount(event: string | symbol) {
    return this._listeners.get(event)?.size || 0;
  }
  listeners(event: string | symbol) {
    const set = this._listeners.get(event);
    return set ? Array.from(set) : [];
  }
}

// Default export should be the EventEmitter class itself for CJS interop
// (code like `import EventEmitter from 'events'` expects the class)
export default EventEmitter;
