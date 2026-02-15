const notAvailable = () => {
  throw new Error('http2 is not available in the browser bundle');
};
export default {};
export const connect = notAvailable;
export const createServer = notAvailable;
