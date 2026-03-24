import { contextBridge, ipcRenderer } from 'electron';
import type {
  LifImageResponse,
  LifParseResponse,
  LmdExportRequest,
  LmdExportResponse,
  LmdLoadResponse,
  LmdSaveRequest,
  LmdSaveResponse
} from '../shared/lifTypes';

const loadRequestListeners = new Set<(filePath?: string) => void>();
let pendingLoadRequestPath: string | undefined;
let hasPendingLoadRequest = false;

ipcRenderer.on('lif:requestLoad', (_event, filePath?: string) => {
  const normalizedPath = typeof filePath === 'string' && filePath.trim().length ? filePath : undefined;
  if (!loadRequestListeners.size) {
    hasPendingLoadRequest = true;
    pendingLoadRequestPath = normalizedPath;
    return;
  }
  for (const listener of loadRequestListeners) {
    listener(normalizedPath);
  }
});

const api = {
  openFiles: (): Promise<string[]> => ipcRenderer.invoke('lif:openFiles'),
  openCsv: (): Promise<string[]> => ipcRenderer.invoke('lif:openCsv'),
  openOverviewImage: (): Promise<string | null> => ipcRenderer.invoke('lif:openOverviewImage'),
  readCsv: (filePath: string): Promise<string> => ipcRenderer.invoke('lif:readCsv', filePath),
  readBinary: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('lif:readBinary', filePath),
  parseFile: (filePath: string): Promise<LifParseResponse> =>
    ipcRenderer.invoke('lif:parseFile', filePath),
  loadImage: (filePath: string, elementId: string): Promise<LifImageResponse> =>
    ipcRenderer.invoke('lif:loadImage', { filePath, elementId }),
  loadThumbnail: (
    filePath: string,
    elementId: string,
    maxSize: number
  ): Promise<LifImageResponse> =>
    ipcRenderer.invoke('lif:loadThumbnail', { filePath, elementId, maxSize }),
  saveProject: (request: LmdSaveRequest): Promise<LmdSaveResponse> =>
    ipcRenderer.invoke('lif:saveProject', request),
  exportFile: (request: LmdExportRequest): Promise<LmdExportResponse> =>
    ipcRenderer.invoke('lif:exportFile', request),
  loadProject: (): Promise<LmdLoadResponse> => ipcRenderer.invoke('lif:loadProject'),
  loadProjectFromPath: (filePath: string): Promise<LmdLoadResponse> =>
    ipcRenderer.invoke('lif:loadProjectFromPath', filePath),
  onSaveRequest: (handler: (mode: 'save' | 'saveAs') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: 'save' | 'saveAs') => {
      handler(mode);
    };
    ipcRenderer.on('lif:requestSave', listener);
    return () => ipcRenderer.removeListener('lif:requestSave', listener);
  },
  onLoadRequest: (handler: (filePath?: string) => void): (() => void) => {
    const listener = (filePath?: string) => handler(filePath);
    loadRequestListeners.add(listener);
    if (hasPendingLoadRequest) {
      const queuedPath = pendingLoadRequestPath;
      hasPendingLoadRequest = false;
      pendingLoadRequestPath = undefined;
      queueMicrotask(() => listener(queuedPath));
    }
    return () => {
      loadRequestListeners.delete(listener);
    };
  },
  onNewProject: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on('lif:requestNewProject', listener);
    return () => ipcRenderer.removeListener('lif:requestNewProject', listener);
  },
  onCloseRequest: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on('lif:requestCloseSession', listener);
    return () => ipcRenderer.removeListener('lif:requestCloseSession', listener);
  },
  confirmClose: (): void => {
    ipcRenderer.send('lif:confirmCloseSession');
  }
};

contextBridge.exposeInMainWorld('lifApi', api);

export type LifApi = typeof api;
