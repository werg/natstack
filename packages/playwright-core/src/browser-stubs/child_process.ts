const notAvailable = () => {
  throw new Error('child_process is not available in the browser bundle');
};
export default {};
export const exec = notAvailable;
export const execSync = () => '';
export const spawn = notAvailable;
export const spawnSync = () => ({ pid: -1 });
