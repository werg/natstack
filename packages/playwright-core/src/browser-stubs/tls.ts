const notAvailable = () => {
  throw new Error('tls is not available in the browser bundle');
};
export default {};
export const connect = notAvailable;
