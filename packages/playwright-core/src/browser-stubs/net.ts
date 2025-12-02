const notAvailable = () => {
  throw new Error('net is not available in the browser bundle');
};
export default {};
export const createConnection = notAvailable;
