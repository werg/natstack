export const join = (...segments: string[]) => segments.join('/').replace(/\/+/g, '/');
export const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '.';
export const basename = (p: string) => p.split('/').pop() || '';
export const extname = (p: string) => {
  const idx = p.lastIndexOf('.');
  return idx >= 0 ? p.substring(idx) : '';
};
export default { join, dirname, basename, extname };
