import { EventEmitter } from './events';

class SimpleStream extends EventEmitter {
  pipe() { return this; }
}

export class Readable extends SimpleStream {}
export class Writable extends SimpleStream {
  write() { return true; }
  end() {}
}

export const pipeline = (..._args: any[]) => { throw new Error('stream.pipeline is not available in browser'); };
export default { Readable, Writable, pipeline };
