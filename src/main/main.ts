import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron';
import * as path from 'path';
import { promises as fs, readFileSync } from 'fs';
import { parseLifFile, loadLifImage, loadLifThumbnail } from './lif';
import {
  LifImageResponse,
  LmdLoadResponse,
  LifParseResponse,
  LmdSaveRequest,
  LmdSaveResponse,
  LmdExportRequest,
  LmdExportResponse
} from '../shared/lifTypes';

let mainWindow: BrowserWindow | null = null;
let allowClose = false;
let pendingProjectPath: string | null = null;

app.setName('LMDmapper');

const normalizeProjectPath = (candidate: string | null | undefined): string | null => {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.startsWith('-') || !trimmed.toLowerCase().endsWith('.lmd')) {
    return null;
  }
  return trimmed;
};

const findProjectPathInArgv = (argv: string[]): string | null => {
  for (const value of argv) {
    const filePath = normalizeProjectPath(value);
    if (filePath) {
      return filePath;
    }
  }
  return null;
};

const focusMainWindow = (): void => {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
};

const dispatchPendingProjectPath = (): void => {
  if (!pendingProjectPath || !mainWindow) {
    return;
  }
  if (mainWindow.webContents.isLoadingMainFrame()) {
    return;
  }
  const filePath = pendingProjectPath;
  pendingProjectPath = null;
  focusMainWindow();
  mainWindow.webContents.send('lif:requestLoad', filePath);
};

const queueProjectPath = (candidate: string | null | undefined): void => {
  const filePath = normalizeProjectPath(candidate);
  if (!filePath) {
    return;
  }
  pendingProjectPath = filePath;
  dispatchPendingProjectPath();
};

const getBuildDate = (): string => {
  try {
    const packagePath = path.join(app.getAppPath(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      buildDate?: string;
    };
    if (typeof packageJson.buildDate === 'string' && packageJson.buildDate.trim().length > 0) {
      return packageJson.buildDate.trim();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[about] failed to read build date:', message);
  }
  return new Date().toISOString().slice(0, 10);
};

const showAboutLmdmapper = (): void => {
  const version = app.getVersion();
  const buildDate = getBuildDate();
  const aboutOptions = {
    type: 'info',
    title: 'About LMDmapper',
    message: `LMDmapper v${version}`,
    detail: `Version: ${version}\nDate: ${buildDate}`
  } as const;
  if (mainWindow) {
    void dialog.showMessageBox(mainWindow, aboutOptions);
    return;
  }
  void dialog.showMessageBox(aboutOptions);
};

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    nativeTheme.themeSource = 'dark';
  }

  allowClose = false;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'LMDmapper',
    minWidth: 1000,
    minHeight: 800,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: false,
    backgroundColor: '#12161d',
    trafficLightPosition: isMac ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
  mainWindow.webContents.on('did-finish-load', () => {
    dispatchPendingProjectPath();
  });

  const menuTemplate = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'LMDmapper',
            submenu: [
              {
                label: 'About LMDmapper',
                click: () => showAboutLmdmapper()
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('lif:requestNewProject');
          }
        },
        { type: 'separator' },
        {
          label: 'Load Session',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('lif:requestLoad');
          }
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow?.webContents.send('lif:requestSave', 'save');
          }
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            mainWindow?.webContents.send('lif:requestSave', 'saveAs');
          }
        },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'quit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' }
            ]
          : [])
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About LMDmapper',
          click: () => {
            showAboutLmdmapper();
          }
        }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(menuTemplate as Electron.MenuItemConstructorOptions[]);
  Menu.setApplicationMenu(menu);
  if (isWindows) {
    mainWindow.setMenuBarVisibility(true);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    allowClose = false;
  });
  mainWindow.on('close', (event) => {
    if (allowClose) {
      return;
    }
    event.preventDefault();
    mainWindow?.webContents.send('lif:requestCloseSession');
  });
}

const loadProjectFile = async (filePath: string): Promise<LmdLoadResponse> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return { filePath, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load session.';
    return { error: message };
  }
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusMainWindow();
    queueProjectPath(findProjectPathInArgv(argv));
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueProjectPath(filePath);
  });

  app.whenReady().then(() => {
    createWindow();
    queueProjectPath(findProjectPathInArgv(process.argv.slice(1)));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
      dispatchPendingProjectPath();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

ipcMain.handle('lif:openFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import LIF files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Leica Image Files', extensions: ['lif'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }
  return result.filePaths;
});

ipcMain.handle('lif:openCsv', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import CSV files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }
  return result.filePaths;
});

ipcMain.handle('lif:openOverviewImage', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import overview image',
    properties: ['openFile'],
    filters: [
      { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('lif:readCsv', async (_event, filePath: string): Promise<string> => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read CSV file.';
    console.error('[csv] read error:', message);
    throw error;
  }
});

ipcMain.handle('lif:readBinary', async (_event, filePath: string): Promise<ArrayBuffer> => {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read file.';
    console.error('[binary] read error:', message);
    throw error;
  }
});

ipcMain.handle('lif:parseFile', async (_event, filePath: string): Promise<LifParseResponse> => {
  try {
    return await parseLifFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to parse LIF file.';
    console.error('[lif] parse error:', message);
    return { error: message };
  }
});

ipcMain.handle(
  'lif:loadImage',
  async (_event, payload: { filePath: string; elementId: string }): Promise<LifImageResponse> => {
    try {
      return await loadLifImage(payload.filePath, payload.elementId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load image.';
      return { elementId: payload.elementId, error: message };
    }
  }
);

ipcMain.handle(
  'lif:loadThumbnail',
  async (
    _event,
    payload: { filePath: string; elementId: string; maxSize: number }
  ): Promise<LifImageResponse> => {
    try {
      return await loadLifThumbnail(payload.filePath, payload.elementId, payload.maxSize);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load thumbnail.';
      return { elementId: payload.elementId, error: message };
    }
  }
);

ipcMain.handle(
  'lif:saveProject',
  async (_event, request: LmdSaveRequest): Promise<LmdSaveResponse> => {
    const { payload, filePath: providedPath, forceDialog } = request;
    let filePath = providedPath;

    if (forceDialog || !filePath) {
      const result = await dialog.showSaveDialog({
        title: 'Save LMDmapper session',
        defaultPath: 'LMDmapper.lmd',
        filters: [
          { name: 'LMDmapper Session', extensions: ['lmd'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      filePath = result.filePath;
    }

    if (!filePath) {
      return { error: 'No file path provided.' };
    }

    if (!filePath.toLowerCase().endsWith('.lmd')) {
      filePath = `${filePath}.lmd`;
    }

    try {
      const data = JSON.stringify(payload, null, 2);
      await fs.writeFile(filePath, data, 'utf8');
      return { filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save session.';
      return { error: message };
    }
  }
);

ipcMain.handle(
  'lif:exportFile',
  async (_event, request: LmdExportRequest): Promise<LmdExportResponse> => {
    const { data, defaultPath, filters, encoding = 'utf8' } = request;
    const result = await dialog.showSaveDialog({
      title: 'Export',
      defaultPath,
      filters: filters && filters.length ? filters : [{ name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    let filePath = result.filePath;
    const preferredExt = filters?.[0]?.extensions?.[0];
    if (preferredExt && !filePath.toLowerCase().endsWith(`.${preferredExt}`)) {
      filePath = `${filePath}.${preferredExt}`;
    }
    try {
      if (encoding === 'base64') {
        const buffer = Buffer.from(data, 'base64');
        await fs.writeFile(filePath, buffer);
      } else {
        await fs.writeFile(filePath, data, 'utf8');
      }
      return { filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export file.';
      return { error: message };
    }
  }
);

ipcMain.handle('lif:loadProject', async (): Promise<LmdLoadResponse> => {
  const result = await dialog.showOpenDialog({
    title: 'Load LMDmapper session',
    properties: ['openFile'],
    filters: [
      { name: 'LMDmapper Session', extensions: ['lmd'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  return loadProjectFile(filePath);
});

ipcMain.handle('lif:loadProjectFromPath', async (_event, filePath: string): Promise<LmdLoadResponse> => {
  const normalizedPath = normalizeProjectPath(filePath);
  if (!normalizedPath) {
    return { error: 'Invalid LMD session path.' };
  }
  return loadProjectFile(normalizedPath);
});

ipcMain.on('lif:confirmCloseSession', () => {
  if (!mainWindow) {
    return;
  }
  allowClose = true;
  mainWindow.close();
});
