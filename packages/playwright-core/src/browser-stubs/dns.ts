const notAvailable = () => {
  throw new Error('dns is not available in the browser bundle');
};
export default {};
export const lookup = notAvailable;
