const custom = Symbol.for('nodejs.util.inspect.custom');

export const promisify = (fn: any) => (...args: any[]) => new Promise((resolve, reject) => {
  try {
    fn(...args, (err: any, result: any) => err ? reject(err) : resolve(result));
  } catch (e) {
    reject(e);
  }
});

export const inspect = { custom };
export default { promisify, inspect };
