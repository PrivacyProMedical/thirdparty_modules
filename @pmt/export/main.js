import os from 'node:os';
import child_process from 'node:child_process';

import * as api from './api/index.js';

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

    exportParsedStandardDirectory: api.exportParsedStandardDirectory,
    // deidentify2DDicom: api.deidentify2DDicom,

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
