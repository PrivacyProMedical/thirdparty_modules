// api loader & runner to ensure the cwd is correct in case the api method relies on relative path
import path from 'node:path';

export function createApiLoader(apiDir, entryFile = 'index.js') {
  const apiLoader = {
    async load() {
      if (this.api) return this.api;
      const cwd = process.cwd();
      process.chdir(apiDir);
      try {
        this.api = await import(path.join(apiDir, entryFile));
      } finally {
        process.chdir(cwd);
      }
      return this.api;
    },
    run(apiFn) {
      return function (...args) {
        const cwd = process.cwd();
        process.chdir(apiDir);
        let res;
        try {
          res = apiFn(...args);
        } catch (err) {
          process.chdir(cwd);
          throw err;
        }
        if (typeof res?.then === 'function') {
          return res.finally(() => process.chdir(cwd));
        }
        process.chdir(cwd);
        return res;
      };
    },
    api: null,
  };
  return apiLoader;
}
