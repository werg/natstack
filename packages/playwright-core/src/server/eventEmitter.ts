/**
 * Copyright Joyent, Inc. and other Node contributors.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Simplified EventEmitter for browser/server environments.
 * Based on Node.js EventEmitter but without platform dependencies.
 */

type EventType = string | symbol;
type Listener = (...args: any[]) => any;
type EventMap = Record<EventType, Listener | Listener[]>;

export class EventEmitter {
  private _events: EventMap | undefined = undefined;
  private _eventsCount = 0;
  private _maxListeners: number | undefined = undefined;

  constructor() {
    this._events = Object.create(null);
    this._eventsCount = 0;
  }

  setMaxListeners(n: number): this {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n))
      throw new RangeError('The value of "n" is out of range. It must be a non-negative number. Received ' + n + '.');
    this._maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return this._maxListeners ?? 10;
  }

  emit(type: EventType, ...args: any[]): boolean {
    const events = this._events;
    if (events === undefined)
      return false;

    const handler = events?.[type];
    if (handler === undefined)
      return false;

    if (typeof handler === 'function') {
      Reflect.apply(handler, this, args);
    } else {
      const len = handler.length;
      const listeners = handler.slice();
      for (let i = 0; i < len; ++i)
        Reflect.apply(listeners[i], this, args);
    }
    return true;
  }

  addListener(type: EventType, listener: Listener): this {
    return this._addListener(type, listener, false);
  }

  on(type: EventType, listener: Listener): this {
    return this._addListener(type, listener, false);
  }

  private _addListener(type: EventType, listener: Listener, prepend: boolean): this {
    checkListener(listener);
    let events = this._events;
    let existing;
    if (events === undefined) {
      events = this._events = Object.create(null);
      this._eventsCount = 0;
    } else {
      existing = events[type];
    }

    if (existing === undefined) {
      existing = events![type] = listener;
      ++this._eventsCount;
    } else {
      if (typeof existing === 'function') {
        existing = events![type] =
          prepend ? [listener, existing] : [existing, listener];
      } else if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }

      // Check for listener leak
      const m = this.getMaxListeners();
      if (m > 0 && existing.length > m && !(existing as any).warned) {
        (existing as any).warned = true;
        console.warn(`Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} listeners added.`);
      }
    }

    return this;
  }

  prependListener(type: EventType, listener: Listener): this {
    return this._addListener(type, listener, true);
  }

  once(type: EventType, listener: Listener): this {
    checkListener(listener);
    const wrapper = (...args: any[]) => {
      this.removeListener(type, wrapper);
      return listener.apply(this, args);
    };
    (wrapper as any).listener = listener;
    this.on(type, wrapper);
    return this;
  }

  prependOnceListener(type: EventType, listener: Listener): this {
    checkListener(listener);
    const wrapper = (...args: any[]) => {
      this.removeListener(type, wrapper);
      return listener.apply(this, args);
    };
    (wrapper as any).listener = listener;
    this.prependListener(type, wrapper);
    return this;
  }

  removeListener(type: EventType, listener: Listener): this {
    checkListener(listener);

    const events = this._events;
    if (events === undefined)
      return this;

    const list = events[type];
    if (list === undefined)
      return this;

    if (list === listener || (list as any).listener === listener) {
      if (--this._eventsCount === 0) {
        this._events = Object.create(null);
      } else {
        delete events[type];
      }
    } else if (typeof list !== 'function') {
      let position = -1;

      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || (list[i] as any).listener === listener) {
          position = i;
          break;
        }
      }

      if (position < 0)
        return this;

      if (position === 0)
        list.shift();
      else
        list.splice(position, 1);

      if (list.length === 1)
        events[type] = list[0];
    }

    return this;
  }

  off(type: EventType, listener: Listener): this {
    return this.removeListener(type, listener);
  }

  removeAllListeners(type?: EventType): this {
    const events = this._events;
    if (!events)
      return this;

    if (type === undefined) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    } else if (events[type] !== undefined) {
      if (--this._eventsCount === 0)
        this._events = Object.create(null);
      else
        delete events[type];
    }
    return this;
  }

  listeners(type: EventType): Listener[] {
    const events = this._events;
    if (events === undefined)
      return [];

    const listener = events[type];
    if (listener === undefined)
      return [];

    if (typeof listener === 'function')
      return [(listener as any).listener ?? listener];

    return listener.map(l => (l as any).listener ?? l);
  }

  rawListeners(type: EventType): Listener[] {
    const events = this._events;
    if (events === undefined)
      return [];

    const listener = events[type];
    if (listener === undefined)
      return [];

    if (typeof listener === 'function')
      return [listener];

    return listener.slice();
  }

  listenerCount(type: EventType): number {
    const events = this._events;
    if (events !== undefined) {
      const listener = events[type];
      if (typeof listener === 'function')
        return 1;
      if (listener !== undefined)
        return listener.length;
    }
    return 0;
  }

  eventNames(): Array<string | symbol> {
    return this._eventsCount > 0 && this._events ? Reflect.ownKeys(this._events) : [];
  }
}

function checkListener(listener: any) {
  if (typeof listener !== 'function')
    throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
}
