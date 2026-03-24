import type {
  LifImageResponse,
  LifParseResponse,
  LmdExportRequest,
  LmdExportResponse,
  LmdLoadResponse,
  LmdSaveRequest,
  LmdSaveResponse
} from '@shared/lifTypes';

type LifApi = {
  openFiles: () => Promise<string[]>;
  openCsv: () => Promise<string[]>;
  openOverviewImage: () => Promise<string | null>;
  readCsv: (filePath: string) => Promise<string>;
  readBinary: (filePath: string) => Promise<ArrayBuffer>;
  parseFile: (filePath: string) => Promise<LifParseResponse>;
  loadImage: (filePath: string, elementId: string) => Promise<LifImageResponse>;
  loadThumbnail: (
    filePath: string,
    elementId: string,
    maxSize: number
  ) => Promise<LifImageResponse>;
  saveProject: (request: LmdSaveRequest) => Promise<LmdSaveResponse>;
  exportFile: (request: LmdExportRequest) => Promise<LmdExportResponse>;
  loadProject: () => Promise<LmdLoadResponse>;
  loadProjectFromPath: (filePath: string) => Promise<LmdLoadResponse>;
  onSaveRequest: (handler: (mode: 'save' | 'saveAs') => void) => () => void;
  onLoadRequest: (handler: (filePath?: string) => void) => () => void;
  onNewProject: (handler: () => void) => () => void;
  onCloseRequest: (handler: () => void) => () => void;
  confirmClose: () => void;
};

declare global {
  interface Window {
    lifApi: LifApi;
  }
}

export {};
