export type LifElement = {
  id: string;
  name: string;
  memoryBlockId?: string;
  memorySize?: number;
  width?: number;
  height?: number;
  channels?: number;
  resolution?: number;
  stageX?: number;
  stageY?: number;
  collectorHolderPosition?: string;
  timestamp?: string;
  laserSettings?: string[];
  supported: boolean;
  sourceFile?: string;
};

export type LifParseResult = {
  filePath: string;
  elements: LifElement[];
};

export type LifParseError = {
  error: string;
};

export type LifParseResponse = LifParseResult | LifParseError;

export type LifImageResult = {
  elementId: string;
  width: number;
  height: number;
  channels: number;
  format: 'rgb' | 'rgba';
  data: ArrayBuffer;
};

export type LifImageError = {
  elementId: string;
  error: string;
};

export type LifImageResponse = LifImageResult | LifImageError;

export type LmdSaveResult = {
  filePath: string;
};

export type LmdSaveError = {
  error: string;
};

export type LmdSaveCanceled = {
  canceled: true;
};

export type LmdSaveResponse = LmdSaveResult | LmdSaveError | LmdSaveCanceled;

export type LmdSaveRequest = {
  payload: Record<string, unknown>;
  filePath?: string;
  forceDialog?: boolean;
};

export type LmdLoadResult = {
  filePath: string;
  data: Record<string, unknown>;
};

export type LmdLoadError = {
  error: string;
};

export type LmdLoadCanceled = {
  canceled: true;
};

export type LmdLoadResponse = LmdLoadResult | LmdLoadError | LmdLoadCanceled;

export type LmdExportRequest = {
  data: string;
  defaultPath: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  encoding?: 'utf8' | 'base64';
};

export type LmdExportResult = {
  filePath: string;
};

export type LmdExportError = {
  error: string;
};

export type LmdExportCanceled = {
  canceled: true;
};

export type LmdExportResponse = LmdExportResult | LmdExportError | LmdExportCanceled;
