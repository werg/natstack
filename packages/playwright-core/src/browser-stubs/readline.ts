const notAvailable = () => {
  throw new Error('readline is not available in the browser bundle');
};
export default {};
export const createInterface = notAvailable;
