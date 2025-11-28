import fs, { PathLike, promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScopedFsOptions {
  root: PathLike;
  virtualRoot?: string;
}

export type ScopedFs = typeof fs;

type ResolveOptions = {
  followFinalSymlink?: boolean;
};

const DEFAULT_VIRTUAL_ROOT = '/';

function toPathString(pathLike: PathLike): string {
  if (typeof pathLike === 'string') return pathLike;
  if (Buffer.isBuffer(pathLike)) return pathLike.toString();
  if (pathLike instanceof URL) return fileURLToPath(pathLike);
  return String(pathLike);
}

function normalizeVirtualRoot(virtualRoot: string | undefined): string {
  if (!virtualRoot) return DEFAULT_VIRTUAL_ROOT;
  const normalized = path.posix.normalize(virtualRoot.replace(/\\/g, '/'));
  const ensuredLeadingSlash = normalized.startsWith('/')
    ? normalized
    : `/${normalized}`;
  if (ensuredLeadingSlash === '/') return '/';
  return ensuredLeadingSlash.replace(/\/+$/, '') || '/';
}

function wantsBuffer(
  options?: BufferEncoding | 'buffer' | { encoding?: BufferEncoding | 'buffer' },
): boolean {
  if (!options) return false;
  if (typeof options === 'string') return options === 'buffer';
  if (typeof options === 'object' && 'encoding' in options) {
    return options.encoding === 'buffer';
  }
  return false;
}

function createAccessError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

function ensureCallback<T extends (...args: any[]) => void>(
  optionsOrCallback: any,
  maybeCallback?: any,
): { options: any; callback: T } {
  if (typeof optionsOrCallback === 'function') {
    return { options: undefined, callback: optionsOrCallback as T };
  }
  if (typeof maybeCallback === 'function') {
    return { options: optionsOrCallback, callback: maybeCallback as T };
  }
  throw new TypeError('Callback must be a function');
}

function formatReturnPath<T>(
  resolver: ScopedPathResolver,
  value: string | Buffer,
  options?: BufferEncoding | { encoding?: BufferEncoding | 'buffer' },
): T {
  const virtualPath = resolver.toVirtualPath(
    typeof value === 'string' ? value : value.toString(),
  );
  return (wantsBuffer(options)
    ? Buffer.from(virtualPath)
    : virtualPath) as unknown as T;
}

class ScopedPathResolver {
  private readonly rootRealPath: string;
  private readonly virtualRoot: string;
  private readonly virtualRootWithSlash: string;

  constructor(root: PathLike, virtualRoot: string = DEFAULT_VIRTUAL_ROOT) {
    const rootPath = path.resolve(toPathString(root));
    const realRoot = fs.realpathSync(rootPath);
    const stat = fs.statSync(realRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Scoped root must be a directory: ${realRoot}`);
    }
    this.rootRealPath = realRoot;
    this.virtualRoot = normalizeVirtualRoot(virtualRoot);
    this.virtualRootWithSlash =
      this.virtualRoot === '/' ? '/' : `${this.virtualRoot}/`;
  }

  resolvePath(pathLike: PathLike, options: ResolveOptions = {}): string {
    const relative = this.normalizeInput(toPathString(pathLike));
    const absoluteTarget = path.resolve(this.rootRealPath, relative);
    this.ensureWithinRoot(absoluteTarget);
    const ancestorRealPath = this.realpathExistingAncestor(absoluteTarget);
    this.ensureWithinRoot(ancestorRealPath);
    if (options.followFinalSymlink !== false && fs.existsSync(absoluteTarget)) {
      const finalReal = fs.realpathSync(absoluteTarget);
      this.ensureWithinRoot(finalReal);
    }
    return absoluteTarget;
  }

  resolveRelativeTo(
    baseDir: string,
    relativePath: PathLike,
    options: ResolveOptions = {},
  ): string {
    const baseRealPath = fs.realpathSync(baseDir);
    this.ensureWithinRoot(baseRealPath);
    const input = toPathString(relativePath).replace(/\\/g, '/');
    if (path.posix.isAbsolute(input)) {
      return this.resolvePath(relativePath, options);
    }
    const absoluteTarget = path.resolve(baseRealPath, input);
    this.ensureWithinRoot(absoluteTarget);
    const ancestorRealPath = this.realpathExistingAncestor(absoluteTarget);
    this.ensureWithinRoot(ancestorRealPath);
    if (options.followFinalSymlink !== false && fs.existsSync(absoluteTarget)) {
      const finalReal = fs.realpathSync(absoluteTarget);
      this.ensureWithinRoot(finalReal);
    }
    return absoluteTarget;
  }

  toVirtualPath(absolutePath: string): string {
    const relativeToRoot = path.relative(this.rootRealPath, absolutePath);
    if (
      relativeToRoot.startsWith('..') ||
      path.isAbsolute(relativeToRoot) ||
      relativeToRoot.includes('..' + path.sep)
    ) {
      throw createAccessError('Resolved path escapes scoped root');
    }
    const posixRelative = relativeToRoot.split(path.sep).join('/');
    if (!posixRelative) return this.virtualRoot;
    return this.virtualRoot === '/'
      ? `/${posixRelative}`
      : `${this.virtualRootWithSlash}${posixRelative}`;
  }

  private normalizeInput(input: string): string {
    const cleaned = input.replace(/\\/g, '/');
    if (cleaned.includes('\0')) {
      throw createAccessError('Path contains null bytes');
    }

    if (cleaned === '' || cleaned === '.') {
      return '';
    }

    if (
      cleaned === this.virtualRoot ||
      cleaned === this.virtualRootWithSlash.slice(0, -1)
    ) {
      return '';
    }

    if (
      cleaned.startsWith(this.virtualRootWithSlash) ||
      cleaned === this.virtualRoot
    ) {
      return cleaned.slice(this.virtualRootWithSlash.length);
    }

    if (this.virtualRoot === '/' && cleaned.startsWith('/')) {
      return cleaned.slice(1);
    }

    if (path.posix.isAbsolute(cleaned)) {
      throw createAccessError('Absolute paths must remain within the scoped root');
    }

    const normalized = path.posix.normalize(`/${cleaned}`).slice(1);
    if (normalized.startsWith('..')) {
      throw createAccessError('Path escapes the scoped root');
    }
    return normalized;
  }

  private realpathExistingAncestor(target: string): string {
    let current = target;
    while (!fs.existsSync(current) && current !== this.rootRealPath) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return fs.realpathSync(current);
  }

  private ensureWithinRoot(target: string): void {
    const relative = path.relative(this.rootRealPath, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw createAccessError('Path escapes the scoped root');
    }
  }
}

function wrapDirPath(dir: fs.Dir, resolver: ScopedPathResolver): fs.Dir {
  try {
    const virtualPath = resolver.toVirtualPath(toPathString(dir.path));
    Object.defineProperty(dir, 'path', {
      value: virtualPath,
      configurable: false,
      enumerable: true,
      writable: false,
    });
  } catch {
    // If we cannot rewrite the path, fall through with the original Dir.
  }
  return dir;
}

export function createScopedFs(options: ScopedFsOptions): ScopedFs {
  const resolver = new ScopedPathResolver(
    options.root,
    options.virtualRoot ?? DEFAULT_VIRTUAL_ROOT,
  );

  const scopedFs: Partial<typeof fs> = { ...fs };
  const scopedPromises: Partial<typeof fsp> = { ...fsp };

  const wrapSinglePath =
    (fn: Function, resolveOptions: ResolveOptions = { followFinalSymlink: true }) =>
    (pathLike: PathLike, ...rest: any[]) =>
      fn.call(fs, resolver.resolvePath(pathLike, resolveOptions), ...rest);

  const wrapTwoPaths =
    (
      fn: Function,
      firstOptions: ResolveOptions = { followFinalSymlink: true },
      secondOptions: ResolveOptions = { followFinalSymlink: true },
    ) =>
    (from: PathLike, to: PathLike, ...rest: any[]) =>
      fn.call(
        fs,
        resolver.resolvePath(from, firstOptions),
        resolver.resolvePath(to, secondOptions),
        ...rest,
      );

  const wrapPromiseSinglePath =
    (
      fn: Function,
      resolveOptions: ResolveOptions = { followFinalSymlink: true },
    ) =>
    (pathLike: PathLike, ...rest: any[]) =>
      fn.call(fsp, resolver.resolvePath(pathLike, resolveOptions), ...rest);

  const wrapPromiseTwoPaths =
    (
      fn: Function,
      firstOptions: ResolveOptions = { followFinalSymlink: true },
      secondOptions: ResolveOptions = { followFinalSymlink: true },
    ) =>
    (from: PathLike, to: PathLike, ...rest: any[]) =>
      fn.call(
        fsp,
        resolver.resolvePath(from, firstOptions),
        resolver.resolvePath(to, secondOptions),
        ...rest,
      );

  // Single-path functions (callback/Sync).
  Object.assign(scopedFs, {
    access: wrapSinglePath(fs.access),
    appendFile: wrapSinglePath(fs.appendFile),
    chmod: wrapSinglePath(fs.chmod),
    chown: wrapSinglePath(fs.chown),
    lchmod: (fs as any).lchmod
      ? wrapSinglePath((fs as any).lchmod, { followFinalSymlink: false })
      : undefined,
    lchown: (fs as any).lchown
      ? wrapSinglePath((fs as any).lchown, { followFinalSymlink: false })
      : undefined,
    lutimes: (fs as any).lutimes
      ? wrapSinglePath((fs as any).lutimes, { followFinalSymlink: false })
      : undefined,
    mkdir: wrapSinglePath(fs.mkdir, { followFinalSymlink: false }),
    open: wrapSinglePath(fs.open),
    readdir: wrapSinglePath(fs.readdir),
    readFile: wrapSinglePath(fs.readFile),
    readlink: wrapSinglePath(fs.readlink, { followFinalSymlink: false }),
    rename: wrapTwoPaths(fs.rename, { followFinalSymlink: false }, { followFinalSymlink: false }),
    rm: wrapSinglePath(fs.rm, { followFinalSymlink: false }),
    rmdir: wrapSinglePath(fs.rmdir, { followFinalSymlink: false }),
    stat: wrapSinglePath(fs.stat),
    lstat: wrapSinglePath(fs.lstat, { followFinalSymlink: false }),
    truncate: wrapSinglePath(fs.truncate),
    unlink: wrapSinglePath(fs.unlink, { followFinalSymlink: false }),
    utimes: wrapSinglePath(fs.utimes),
    watch: wrapSinglePath(fs.watch, { followFinalSymlink: false }),
    watchFile: wrapSinglePath(fs.watchFile, { followFinalSymlink: false }),
    unwatchFile: wrapSinglePath(fs.unwatchFile, { followFinalSymlink: false }),
    writeFile: wrapSinglePath(fs.writeFile),
  });

  // Two-path functions (callback/Sync).
  (scopedFs as any).copyFile = wrapTwoPaths(fs.copyFile);
  if ((fs as any).cp) {
    (scopedFs as any).cp = wrapTwoPaths((fs as any).cp);
  }
  (scopedFs as any).link = wrapTwoPaths(fs.link, { followFinalSymlink: true }, { followFinalSymlink: false });

  (scopedFs as any).symlink = (
    target: PathLike,
    linkPath: PathLike,
    type?: fs.symlink.Type | null,
    callback?: (err: NodeJS.ErrnoException | null) => void,
  ) => {
    const resolvedLink = resolver.resolvePath(linkPath, {
      followFinalSymlink: false,
    });
    const baseDir = path.dirname(resolvedLink);
    const resolvedTarget = resolver.resolveRelativeTo(
      baseDir,
      target,
      { followFinalSymlink: true },
    );
    return fs.symlink(resolvedTarget, resolvedLink, type as any, callback as any);
  };

  (scopedFs as any).createReadStream = (
    pathLike: PathLike,
    options?: any,
  ) => {
    const resolvedPath = resolver.resolvePath(pathLike, {
      followFinalSymlink: true,
    });
    const stream = fs.createReadStream(resolvedPath, options);
    try {
      (stream as any).path = resolver.toVirtualPath(resolvedPath);
    } catch {
      // ignore assignment errors
    }
    return stream;
  };

  (scopedFs as any).createWriteStream = (
    pathLike: PathLike,
    options?: any,
  ) => {
    const resolvedPath = resolver.resolvePath(pathLike, {
      followFinalSymlink: true,
    });
    const stream = fs.createWriteStream(resolvedPath, options);
    try {
      (stream as any).path = resolver.toVirtualPath(resolvedPath);
    } catch {
      // ignore assignment errors
    }
    return stream;
  };

  (scopedFs as any).exists = (pathLike: PathLike, callback: (exists: boolean) => void) =>
    fs.exists(resolver.resolvePath(pathLike, { followFinalSymlink: false }), callback);

  (scopedFs as any).mkdtemp = (
    prefix: PathLike,
    optionsOrCb?: any,
    maybeCb?: any,
  ) => {
    const { options, callback } = ensureCallback(optionsOrCb, maybeCb);
    const resolvedPrefix = resolver.resolvePath(prefix, {
      followFinalSymlink: false,
    });
    return fs.mkdtemp(resolvedPrefix, options, (err, value) => {
      if (err) return callback(err);
      callback(null, formatReturnPath(resolver, value, options));
    });
  };

  (scopedFs as any).mkdtempSync = (prefix: PathLike, options?: any) => {
    const resolvedPrefix = resolver.resolvePath(prefix, {
      followFinalSymlink: false,
    });
    const value = fs.mkdtempSync(resolvedPrefix, options);
    return formatReturnPath(resolver, value, options);
  };

  const realpathWrapper = (
    realpathFn: Function,
    resolveOptions: ResolveOptions,
  ) =>
    (pathLike: PathLike, optionsOrCb?: any, maybeCb?: any) => {
      const { options, callback } = ensureCallback(optionsOrCb, maybeCb);
      const resolvedPath = resolver.resolvePath(pathLike, resolveOptions);
      return realpathFn.call(fs, resolvedPath, options, (err: any, value: any) => {
        if (err) return callback(err);
        callback(null, formatReturnPath(resolver, value, options));
      });
    };

  (scopedFs as any).realpath = realpathWrapper(fs.realpath, {
    followFinalSymlink: true,
  });

  (scopedFs as any).realpathSync = (
    pathLike: PathLike,
    options?: any,
  ) => {
    const resolvedPath = resolver.resolvePath(pathLike, {
      followFinalSymlink: true,
    });
    const value = fs.realpathSync(resolvedPath, options);
    return formatReturnPath(resolver, value, options);
  };

  if ((fs.realpath as any).native) {
    (scopedFs as any).realpath.native = realpathWrapper(
      (fs.realpath as any).native,
      { followFinalSymlink: true },
    );
  }
  if ((fs.realpathSync as any).native) {
    (scopedFs as any).realpathSync.native = (
      pathLike: PathLike,
      options?: any,
    ) => {
      const resolvedPath = resolver.resolvePath(pathLike, {
        followFinalSymlink: true,
      });
      const value = (fs.realpathSync as any).native(resolvedPath, options);
      return formatReturnPath(resolver, value, options);
    };
  }

  (scopedFs as any).opendir = (
    pathLike: PathLike,
    optionsOrCb?: any,
    maybeCb?: any,
  ) => {
    const { options, callback } = ensureCallback(optionsOrCb, maybeCb);
    const resolvedPath = resolver.resolvePath(pathLike, {
      followFinalSymlink: true,
    });
    return fs.opendir(resolvedPath, options, (err, dir) => {
      if (err) return callback(err);
      callback(null, wrapDirPath(dir, resolver));
    });
  };

  // Promise-based APIs.
  Object.assign(scopedPromises, {
    access: wrapPromiseSinglePath(fsp.access),
    appendFile: wrapPromiseSinglePath(fsp.appendFile),
    chmod: wrapPromiseSinglePath(fsp.chmod),
    chown: wrapPromiseSinglePath(fsp.chown),
    lchmod: (fsp as any).lchmod
      ? wrapPromiseSinglePath((fsp as any).lchmod, { followFinalSymlink: false })
      : undefined,
    lchown: (fsp as any).lchown
      ? wrapPromiseSinglePath((fsp as any).lchown, { followFinalSymlink: false })
      : undefined,
    lutimes: (fsp as any).lutimes
      ? wrapPromiseSinglePath((fsp as any).lutimes, { followFinalSymlink: false })
      : undefined,
    mkdir: wrapPromiseSinglePath(fsp.mkdir, { followFinalSymlink: false }),
    open: wrapPromiseSinglePath(fsp.open),
    readdir: wrapPromiseSinglePath(fsp.readdir),
    readFile: wrapPromiseSinglePath(fsp.readFile),
    readlink: wrapPromiseSinglePath(fsp.readlink, { followFinalSymlink: false }),
    rename: wrapPromiseTwoPaths(fsp.rename, { followFinalSymlink: false }, { followFinalSymlink: false }),
    rm: wrapPromiseSinglePath(fsp.rm, { followFinalSymlink: false }),
    rmdir: wrapPromiseSinglePath(fsp.rmdir, { followFinalSymlink: false }),
    stat: wrapPromiseSinglePath(fsp.stat),
    lstat: wrapPromiseSinglePath(fsp.lstat, { followFinalSymlink: false }),
    truncate: wrapPromiseSinglePath(fsp.truncate),
    unlink: wrapPromiseSinglePath(fsp.unlink, { followFinalSymlink: false }),
    utimes: wrapPromiseSinglePath(fsp.utimes),
    writeFile: wrapPromiseSinglePath(fsp.writeFile),
  });

  (scopedPromises as any).copyFile = wrapPromiseTwoPaths(fsp.copyFile);
  if ((fsp as any).cp) {
    (scopedPromises as any).cp = wrapPromiseTwoPaths((fsp as any).cp);
  }
  (scopedPromises as any).link = wrapPromiseTwoPaths(fsp.link, { followFinalSymlink: true }, { followFinalSymlink: false });

  (scopedPromises as any).symlink = async (
    target: PathLike,
    linkPath: PathLike,
    type?: fs.symlink.Type,
  ) => {
    const resolvedLink = resolver.resolvePath(linkPath, {
      followFinalSymlink: false,
    });
    const baseDir = path.dirname(resolvedLink);
    const resolvedTarget = resolver.resolveRelativeTo(
      baseDir,
      target,
      { followFinalSymlink: true },
    );
    return fsp.symlink(resolvedTarget, resolvedLink, type);
  };

  (scopedPromises as any).mkdtemp = async (
    prefix: PathLike,
    options?: any,
  ) => {
    const resolvedPrefix = resolver.resolvePath(prefix, {
      followFinalSymlink: false,
    });
    const value = await fsp.mkdtemp(resolvedPrefix, options);
    return formatReturnPath(resolver, value, options);
  };

  (scopedPromises as any).realpath = async (
    pathLike: PathLike,
    options?: any,
  ) => {
    const resolvedPath = resolver.resolvePath(pathLike, {
      followFinalSymlink: true,
    });
    const value = await fsp.realpath(resolvedPath, options);
    return formatReturnPath(resolver, value, options);
  };

  if ((fsp.realpath as any).native) {
    (scopedPromises.realpath as any).native = async (
      pathLike: PathLike,
      options?: any,
    ) => {
      const resolvedPath = resolver.resolvePath(pathLike, {
        followFinalSymlink: true,
      });
      const value = await (fsp.realpath as any).native(resolvedPath, options);
      return formatReturnPath(resolver, value, options);
    };
  }

  (scopedPromises as any).opendir = async (
    pathLike: PathLike,
    options?: any,
  ) => {
    const resolvedPath = resolver.resolvePath(pathLike, {
      followFinalSymlink: true,
    });
    const dir = await fsp.opendir(resolvedPath, options);
    return wrapDirPath(dir, resolver);
  };

  (scopedFs as any).promises = scopedPromises as typeof fsp;

  return scopedFs as ScopedFs;
}
