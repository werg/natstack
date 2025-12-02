// Browser-friendly stubs for zip dependencies.
export const yazl: any = {};
export const yauzl: any = {};
export const extract: any = () => {
  throw new Error('zip extraction is not available in the browser bundle');
};
