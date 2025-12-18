/**
 * Scoped filesystem implementation for worker sandboxes.
 *
 * This file is read at build time and injected into worker bundles.
 * It uses real Node.js fs with path validation to prevent escape from scope root.
 *
 * Runtime requirements:
 * - globalThis.__natstackFsRoot must be set to the scope root path
 * - require("__natstack_real_fs__") must resolve to Node.js "fs"
 * - require("__natstack_real_path__") must resolve to Node.js "path"
 */

// Get the real Node.js modules (mapped by esbuild plugin)
const _fs = require("__natstack_real_fs__");
const _path = require("__natstack_real_path__");

// Get the scope root from the global set by the utility process
const _root = globalThis.__natstackFsRoot;
if (!_root) {
  throw new Error("[NatStack] __natstackFsRoot not set - filesystem is not available");
}

// Ensure the root directory exists
try {
  _fs.mkdirSync(_root, { recursive: true });
} catch (e) {
  // Ignore if already exists
}

// Get the real path of the root (resolve symlinks)
const _realRoot = _fs.realpathSync(_root);

/**
 * Resolve and validate a path, ensuring it stays within the scoped root.
 * Throws an error if the path would escape the root.
 */
function _resolvePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("Path must be a non-empty string");
  }

  // Normalize the input path
  let normalizedInput = inputPath.replace(/\\/g, "/");

  // Handle absolute paths: treat them as relative to the scope root
  if (_path.isAbsolute(normalizedInput)) {
    // Remove leading slash(es) to make it relative
    normalizedInput = normalizedInput.replace(/^\/+/, "");
  }

  // Resolve to absolute path within scope
  const absolutePath = _path.resolve(_realRoot, normalizedInput);

  // Validate: ensure the resolved path is within the root
  const relative = _path.relative(_realRoot, absolutePath);
  if (relative.startsWith("..") || _path.isAbsolute(relative)) {
    throw new Error(`Path '${inputPath}' escapes the scoped root`);
  }

  // If the path exists, also validate its real path (follow symlinks)
  if (_fs.existsSync(absolutePath)) {
    try {
      const realPath = _fs.realpathSync(absolutePath);
      const realRelative = _path.relative(_realRoot, realPath);
      if (realRelative.startsWith("..") || _path.isAbsolute(realRelative)) {
        throw new Error(`Path '${inputPath}' resolves outside the scoped root`);
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  return absolutePath;
}

/**
 * Resolve two paths (for operations like rename, copyFile)
 */
function _resolveTwoPaths(from, to) {
  return [_resolvePath(from), _resolvePath(to)];
}

// Create wrapped versions of all fs methods
const scopedFs = {};
const scopedPromises = {};

// Single-path async methods
const singlePathAsyncMethods = [
  "access", "appendFile", "chmod", "chown", "lstat", "mkdir", "open",
  "readdir", "readFile", "readlink", "realpath", "rmdir", "rm", "stat",
  "truncate", "unlink", "utimes", "writeFile", "lchmod", "lchown", "lutimes"
];

for (const method of singlePathAsyncMethods) {
  if (_fs.promises[method]) {
    scopedPromises[method] = (path, ...args) => _fs.promises[method](_resolvePath(path), ...args);
  }
}

// Two-path async methods
const twoPathAsyncMethods = ["copyFile", "link", "rename"];
for (const method of twoPathAsyncMethods) {
  if (_fs.promises[method]) {
    scopedPromises[method] = (from, to, ...args) => {
      const [resolvedFrom, resolvedTo] = _resolveTwoPaths(from, to);
      return _fs.promises[method](resolvedFrom, resolvedTo, ...args);
    };
  }
}

// Special handling for symlink (target relative to link location)
scopedPromises.symlink = async (target, path, type) => {
  const resolvedPath = _resolvePath(path);
  // Resolve target relative to the link's directory
  const linkDir = _path.dirname(resolvedPath);
  const resolvedTarget = _path.isAbsolute(target)
    ? _resolvePath(target)
    : _path.resolve(linkDir, target);
  // Validate target is within scope
  const targetRelative = _path.relative(_realRoot, resolvedTarget);
  if (targetRelative.startsWith("..") || _path.isAbsolute(targetRelative)) {
    throw new Error(`Symlink target '${target}' escapes the scoped root`);
  }
  return _fs.promises.symlink(resolvedTarget, resolvedPath, type);
};

// mkdtemp needs special handling
scopedPromises.mkdtemp = async (prefix, options) => {
  const resolvedPrefix = _resolvePath(prefix);
  const result = await _fs.promises.mkdtemp(resolvedPrefix, options);
  // Return path relative to root (as if root is /)
  return "/" + _path.relative(_realRoot, result);
};

// realpath should return scoped path
const originalRealpath = scopedPromises.realpath;
scopedPromises.realpath = async (path, options) => {
  const result = await originalRealpath(path, options);
  // Validate result is within scope
  const relative = _path.relative(_realRoot, result);
  if (relative.startsWith("..") || _path.isAbsolute(relative)) {
    throw new Error(`realpath result escapes the scoped root`);
  }
  return "/" + relative;
};

// opendir
scopedPromises.opendir = (path, options) => _fs.promises.opendir(_resolvePath(path), options);

// Single-path sync methods
const singlePathSyncMethods = [
  "accessSync", "appendFileSync", "chmodSync", "chownSync", "lstatSync",
  "mkdirSync", "readdirSync", "readFileSync", "readlinkSync", "realpathSync",
  "rmdirSync", "rmSync", "statSync", "truncateSync", "unlinkSync", "utimesSync",
  "writeFileSync", "existsSync", "openSync", "closeSync"
];

for (const method of singlePathSyncMethods) {
  if (_fs[method]) {
    scopedFs[method] = (path, ...args) => _fs[method](_resolvePath(path), ...args);
  }
}

// Two-path sync methods
const twoPathSyncMethods = ["copyFileSync", "linkSync", "renameSync"];
for (const method of twoPathSyncMethods) {
  if (_fs[method]) {
    scopedFs[method] = (from, to, ...args) => {
      const [resolvedFrom, resolvedTo] = _resolveTwoPaths(from, to);
      return _fs[method](resolvedFrom, resolvedTo, ...args);
    };
  }
}

// symlinkSync
scopedFs.symlinkSync = (target, path, type) => {
  const resolvedPath = _resolvePath(path);
  const linkDir = _path.dirname(resolvedPath);
  const resolvedTarget = _path.isAbsolute(target)
    ? _resolvePath(target)
    : _path.resolve(linkDir, target);
  const targetRelative = _path.relative(_realRoot, resolvedTarget);
  if (targetRelative.startsWith("..") || _path.isAbsolute(targetRelative)) {
    throw new Error(`Symlink target '${target}' escapes the scoped root`);
  }
  return _fs.symlinkSync(resolvedTarget, resolvedPath, type);
};

// mkdtempSync
scopedFs.mkdtempSync = (prefix, options) => {
  const resolvedPrefix = _resolvePath(prefix);
  const result = _fs.mkdtempSync(resolvedPrefix, options);
  return "/" + _path.relative(_realRoot, result);
};

// realpathSync should return scoped path
const originalRealpathSync = scopedFs.realpathSync;
scopedFs.realpathSync = (path, options) => {
  const result = originalRealpathSync(path, options);
  const relative = _path.relative(_realRoot, result);
  if (relative.startsWith("..") || _path.isAbsolute(relative)) {
    throw new Error(`realpathSync result escapes the scoped root`);
  }
  return "/" + relative;
};

// exists (deprecated but used by some packages)
scopedFs.exists = (path, callback) => {
  try {
    const resolved = _resolvePath(path);
    _fs.exists(resolved, callback);
  } catch (e) {
    callback(false);
  }
};

// createReadStream / createWriteStream
scopedFs.createReadStream = (path, options) => _fs.createReadStream(_resolvePath(path), options);
scopedFs.createWriteStream = (path, options) => _fs.createWriteStream(_resolvePath(path), options);

// watch / watchFile / unwatchFile
scopedFs.watch = (path, ...args) => _fs.watch(_resolvePath(path), ...args);
scopedFs.watchFile = (path, ...args) => _fs.watchFile(_resolvePath(path), ...args);
scopedFs.unwatchFile = (path, ...args) => _fs.unwatchFile(_resolvePath(path), ...args);

// File descriptor operations (need to track fds) - pass through since they use fd not path
scopedFs.read = _fs.read;
scopedFs.readSync = _fs.readSync;
scopedFs.write = _fs.write;
scopedFs.writeSync = _fs.writeSync;
scopedFs.fstat = _fs.fstat;
scopedFs.fstatSync = _fs.fstatSync;
scopedFs.ftruncate = _fs.ftruncate;
scopedFs.ftruncateSync = _fs.ftruncateSync;
scopedFs.futimes = _fs.futimes;
scopedFs.futimesSync = _fs.futimesSync;
scopedFs.fsync = _fs.fsync;
scopedFs.fsyncSync = _fs.fsyncSync;
scopedFs.fdatasync = _fs.fdatasync;
scopedFs.fdatasyncSync = _fs.fdatasyncSync;
scopedFs.fchown = _fs.fchown;
scopedFs.fchownSync = _fs.fchownSync;
scopedFs.fchmod = _fs.fchmod;
scopedFs.fchmodSync = _fs.fchmodSync;
scopedFs.close = _fs.close;
scopedFs.closeSync = _fs.closeSync;

// Constants
scopedFs.constants = _fs.constants;

// Attach promises
scopedFs.promises = scopedPromises;

// Export everything
module.exports = scopedFs;
module.exports.default = scopedFs;
module.exports.promises = scopedPromises;
