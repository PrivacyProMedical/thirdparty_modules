import os from 'node:os';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// api loader to ensure the cwd is correct when running api function in case it relies on relative path
function createApiLoader(apiDir) {
  const apiLoader = {
    async load() {
      if (this.api) return this.api;
      const cwd = process.cwd();
      process.chdir(apiDir);
      try {
        this.api = await import('./api/index.js');
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
const apiDir = resolve(__dirname, 'api');
const apiLoader = createApiLoader(apiDir);
const apiReady = apiLoader.load();

const platform = process.platform || os.platform();
const isMac = platform === 'darwin';
// const isWin = platform === 'win32';

const contextMenus = [
  {
    slots: ['patient', 'study', 'series', 'instance'],
    label: 'Export',
    click: async (ctx, ...args) => {},
    ui: true,
  },
  // /*
  isMac && {
    slots: ['folder', 'file'],
    label: 'Export & Anonymize',
    submenu: [
      {
        slots: ['folder'],
        label: 'Copy Name',
        click: async (ctx, ...args) => {
          const data = ctx?.selection?.name ?? '';
          if (data) {
            pbcopy(data);
            return data;
          }
        },
        ui: false,
      },
      {
        slots: ['file'],
        label: 'Copy Path',
        click: async (ctx, ...args) => {
          const data = ctx?.selection?.path ?? '';
          if (data) {
            pbcopy(data);
            return data;
          }
        },
        ui: false,
      },
    ],
  },
  // */
].filter(Boolean);

export default {
  meta: {
    name: 'Export & Anonymize',
    // ...
  },
  async setup(options, electronApp) {
    return electronApp.whenReady().then(() => {
      // ...
    });
  },
  ui: {
    entry: 'ui/index.html',
    windowOptions: {
      width: 720,
      height: 640,
      minWidth: 400,
      minHeight: 300,
    },
  },
  api: {
    test: (...args) => ({ args }),

    exportParsedStandardDirectory: async (...args) => apiReady.then(api => apiLoader.run(api.exportParsedStandardDirectory)(...args)),
    // deidentify2DDicom: async (...args) => apiReady.then(api => apiLoader.run(api.deidentify2DDicom)(...args)),

    // ...

    // ipcRenderer.invoke(`@pmt/export/@contextmenu`, ...
    '@contextmenu': (indexes, ctx, ...args) => {
      let item = null;
      for (let i = 0; i < indexes.length; i++) {
        const index = indexes[i];
        item = i === 0 ? contextMenus[index] : item.submenu?.[index];
      }
      if (item && typeof item.click === 'function') {
        return item.click(ctx, ...args);
      }
    },
  },
  contextMenus,
};

function pbcopy(data) {
  if (!isMac) {
    return;
  }
  try {
    const p = child_process.spawn('pbcopy');
    p.stdin.write(data);
    p.stdin.end();
  } catch (err) {}
}
