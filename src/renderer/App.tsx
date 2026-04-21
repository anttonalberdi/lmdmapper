import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent,
  RefObject,
  WheelEvent
} from 'react';
import type { LifElement, LmdLoadResponse, LifParseResponse, LmdSaveResponse } from '@shared/lifTypes';
import packageJson from '../../package.json';
import logo from './assets/logo.png';

const EMPTY_STATE = 'Import LIF files to start a session.';
const USER_DIRECTORY_KEY = 'lmdmapper.userDirectory';
const DEFAULT_SESSION_USERS = ['Amalia Bogri', 'Bryan Wang', 'Jaime Ramirez', 'Nanna Gaun'];
const DEFAULT_STAGE_POSITION = 2;
const DEFAULT_MICROSAMPLE_START = 1;
const APP_VERSION = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
const MANUAL_COORDINATE_LABEL = 'Manual coordinate';
const DEFAULT_MICRONS_PER_PIXEL = 0.326137;

type ThumbState = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  size: number;
};

type UiElement = LifElement & {
  uiId: string;
  sourceFile: string;
};

type ImageInferenceCandidate = {
  pre?: UiElement;
  post?: UiElement;
  order: number;
  collectorHolderPosition?: string;
};

type OrphanAssignmentTarget = {
  plateIndex: number;
  rowIndex: number;
  colIndex: number;
  plateLabel: string;
  well: string;
  code?: string;
  sample: SampleType;
};

type OrphanAssignmentImageOption = {
  key: string;
  imageName: string;
  group: 'pre' | 'post';
  sequence: number;
  elementId: string;
  sourceFile: string;
  stageX?: number;
  stageY?: number;
  width?: number;
  height?: number;
};

type OrphanAssignmentPromptState = {
  mode: 'orphan-click' | 'metadata-well';
  contextLabel: string;
  collector?: string;
  pixelX?: number;
  pixelY?: number;
  initialTargetKey?: string;
  targets: OrphanAssignmentTarget[];
  imageOptions: OrphanAssignmentImageOption[];
};

type OrphanAssignmentPreviewState = {
  thumb?: ThumbState;
  loading: boolean;
  error?: string;
};

type CoordinateImagePoint = {
  id: string;
  elementId: string;
  name: string;
  sourceFile: string;
  x: number;
  y: number;
  supported: boolean;
  width?: number;
  height?: number;
  orphan: boolean;
  sequence: number;
};

type ManualCoordinatePromptState = {
  x: number;
  y: number;
  targets: OrphanAssignmentTarget[];
};

const isManualCoordinateLabel = (value?: string) => {
  const normalized = value?.trim();
  return normalized === MANUAL_COORDINATE_LABEL || normalized === 'Manual coordinates';
};

type ManualPointUndoEntry = {
  csvPlatesByCryo: CsvCell[][][][];
  csvPlacementsByCryo: CsvPlacement[][];
  coordinateCache: Record<string, { x: number; y: number }>;
  coordinateOverridesByCryo: Array<Record<string, true>>;
  cutPointVisibilityByCryo: Array<Record<string, { point: boolean; image: boolean }>>;
  selectedCutIdsByCryo: string[][];
};

function useCanvasResize(
  canvasRef: RefObject<HTMLCanvasElement>,
  containerRef: RefObject<HTMLDivElement>,
  onResize?: () => void,
  dependency?: unknown
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
      onResize?.();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [canvasRef, containerRef, onResize, dependency]);
}

function formatNumber(value?: number, digits = 2): string {
  if (value === undefined) {
    return '—';
  }
  return value.toFixed(digits);
}

function formatOverviewAlignmentValue(
  field: 'scaleX' | 'scaleY' | 'offsetX' | 'offsetY',
  value: number
): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  return field === 'scaleX' || field === 'scaleY' ? value.toFixed(2) : value.toFixed(1);
}

function csvEscape(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function safeFilename(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}

function normalizeUserList(users: string[]): string[] {
  const deduped = new Set<string>();
  for (const raw of users) {
    const value = raw.trim();
    if (value) {
      deduped.add(value);
    }
  }
  return Array.from(deduped);
}

function formatSessionUsers(users: string[]): string {
  if (!users.length) {
    return 'Unknown user';
  }
  return users.join(', ');
}

function createSession(users: string[]): SessionEntry {
  const normalizedUsers = normalizeUserList(users);
  return {
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    users: normalizedUsers,
    user: formatSessionUsers(normalizedUsers),
    startTime: new Date().toISOString(),
    status: 'open'
  };
}

function createHistoryEntry(
  snapshot: Record<string, unknown>,
  savedAt: string,
  user?: string,
  sessionId?: string
): HistoryEntry {
  return {
    id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    savedAt,
    user,
    sessionId,
    snapshot
  };
}

function appendHistoryEntry(entries: HistoryEntry[], next: HistoryEntry): HistoryEntry[] {
  const last = entries[entries.length - 1];
  if (last) {
    try {
      if (JSON.stringify(last.snapshot) === JSON.stringify(next.snapshot)) {
        return entries;
      }
    } catch {
      // ignore comparison errors, append anyway
    }
  }
  return [...entries, next];
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRect(rect: { x: number; y: number; w: number; h: number }) {
  const x = rect.w >= 0 ? rect.x : rect.x + rect.w;
  const y = rect.h >= 0 ? rect.y : rect.y + rect.h;
  return {
    x,
    y,
    w: Math.abs(rect.w),
    h: Math.abs(rect.h)
  };
}

function pointInRect(point: { x: number; y: number }, rect: { x: number; y: number; w: number; h: number }): boolean {
  const norm = normalizeRect(rect);
  return (
    point.x >= norm.x &&
    point.x <= norm.x + norm.w &&
    point.y >= norm.y &&
    point.y <= norm.y + norm.h
  );
}

function cursorForHandle(
  handle: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
): string {
  if (handle === 'move') {
    return 'move';
  }
  if (handle === 'n' || handle === 's') {
    return 'ns-resize';
  }
  if (handle === 'e' || handle === 'w') {
    return 'ew-resize';
  }
  if (handle === 'ne' || handle === 'sw') {
    return 'nesw-resize';
  }
  if (handle === 'nw' || handle === 'se') {
    return 'nwse-resize';
  }
  return 'default';
}

function niceStep(value: number): number {
  if (value <= 0 || !Number.isFinite(value)) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const fraction = value / base;
  let niceFraction = 1;
  if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }
  return niceFraction * base;
}

function formatStageValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return value.toFixed(0);
  }
  if (abs >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function closestDistanceToPolyline(
  px: number,
  py: number,
  polyline: Array<{ x: number; y: number }>,
  closed: boolean
): number | undefined {
  if (polyline.length < 2) {
    return undefined;
  }
  const points = closed ? [...polyline, polyline[0]] : polyline;
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = px - a.x;
    const apy = py - a.y;
    const denom = abx * abx + aby * aby;
    const t = denom === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
    const cx = a.x + t * abx;
    const cy = a.y + t * aby;
    const dx = px - cx;
    const dy = py - cy;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
    }
  }
  return Number.isFinite(bestDistSq) ? Math.sqrt(bestDistSq) : undefined;
}

function closestPolylineSegmentIndex(
  px: number,
  py: number,
  polyline: Array<{ x: number; y: number }>,
  closed: boolean
): { index: number; distance: number } | undefined {
  if (polyline.length < 2) {
    return undefined;
  }
  const points = closed ? [...polyline, polyline[0]] : polyline;
  let best:
    | {
        index: number;
        distance: number;
      }
    | undefined;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = px - a.x;
    const apy = py - a.y;
    const denom = abx * abx + aby * aby;
    const t = denom === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
    const cx = a.x + t * abx;
    const cy = a.y + t * aby;
    const dx = px - cx;
    const dy = py - cy;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (!best || distance < best.distance) {
      best = { index, distance };
    }
  }
  return best;
}

type ElementGroup = 'pre' | 'post' | 'other';
type SampleType = 'P' | 'M' | 'Z' | 'R' | 'N';
type CollectionCell = { left: number; right: number; rightTouched?: boolean };
type ProjectType =
  | 'Split-plate two cryosections'
  | 'One plate two cryosections'
  | 'One plate one cryosection'
  | 'Flexible multi-cryosection';
type CryosectionConfig = {
  name: string;
  color: string;
  stagePosition: number | null;
};
type PlateSegmentAssignment = {
  cryoIndex: number | null;
  positiveStart: number;
  positiveManual?: boolean;
  negativeStart: number;
  negativeManual?: boolean;
};
type PlateAssignment = {
  split: boolean;
  segments: [PlateSegmentAssignment, PlateSegmentAssignment];
};
type CsvCell = {
  size?: number;
  images?: string;
  preImage?: string;
  cutImage?: string;
  pixelX?: number;
  pixelY?: number;
  sourceOrder?: number;
  inferred?: boolean;
  inferenceConfirmed?: boolean;
  manualAssigned?: boolean;
  present?: boolean;
};
type CsvPlacement = CsvCell & {
  plateIndex: number;
  rowIndex: number;
  colIndex: number;
  rowLetter: string;
};
type MergedCsvCell = CsvCell & { cryoIndex?: number };
type PlateConfig = {
  label: string;
  leftName: string;
  rightName: string;
  notes: string;
  cells: SampleType[][];
};
type OverviewLayerState = {
  filePath: string | null;
  bitmap: ImageBitmap | null;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  visible: boolean;
};
type OverviewState = {
  pre: OverviewLayerState;
  post: OverviewLayerState;
  linked: boolean;
  showCutPoints: boolean;
  showCutImages: boolean;
  showOrphanImages: boolean;
  showMembraneControls: boolean;
  showPre: boolean;
  showPost: boolean;
  activeLayer: 'pre' | 'post';
};
type OverviewSelectionState = {
  enabled: boolean;
  aspect: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  outputScale: number;
};
type OverviewCropResult = {
  rectPx: { x: number; y: number; w: number; h: number } | null;
  cuts: Array<{
    id: string;
    well: string;
    code?: string;
    plateLabel?: string;
    x: number;
    y: number;
  }>;
  layer: 'pre' | 'post';
};
type OverviewContour = {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  closed: boolean;
  points: Array<{ x: number; y: number }>;
};
type OverviewAlignmentField = 'scaleX' | 'scaleY' | 'offsetX' | 'offsetY';
type ExportSize = { w: number; h: number } | null;
type ThumbnailRequest = { size: number; elementId: string; sourceFile: string };
type SessionEntry = {
  id: string;
  users: string[];
  user?: string;
  startTime: string;
  endTime?: string;
  status?: 'open' | 'closed' | 'interrupted';
};
type HistoryEntry = {
  id: string;
  savedAt: string;
  user?: string;
  sessionId?: string;
  snapshot: Record<string, unknown>;
};
type RandomAssignmentSettings = {
  M: number;
  Z: number;
  R: number;
  maxControlsPerColumn: number;
  sustainabilityMode: boolean;
};
type CollectionEncodingMode = 'corrected' | 'legacy';
type CollectionMetadata = {
  collectionMethod: string;
  encodingMode: CollectionEncodingMode;
  date: string;
  temperature: string;
  humidity: string;
  notes: string;
  startTime: string;
  endTime: string;
  startTimeManual: boolean;
  endTimeManual: boolean;
};
type MetadataColumnKey =
  | 'status'
  | 'well'
  | 'plate'
  | 'batch'
  | 'cryosection'
  | 'sampleType'
  | 'microsample'
  | 'number'
  | 'shape'
  | 'collection'
  | 'collectionMethod'
  | 'images'
  | 'pixelx'
  | 'pixely'
  | 'xcoord'
  | 'ycoord'
  | 'size'
  | 'notes';
type MetadataSearchScope = 'all' | string;
type MetadataDisplayColumn = {
  key: string;
  label: string;
  isContour?: boolean;
  contourId?: string;
  contourCryoIndex?: number;
};

const MAX_CRYOSECTIONS = 4;
const MAX_PLATES = 2;
const PLATE_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const PLATE_COLS = Array.from({ length: 12 }, (_, index) => index + 1);
const DEFAULT_SAMPLE: SampleType = 'P';
const DISABLED_SAMPLE: SampleType = 'N';
const SAMPLE_OPTIONS: Array<{ type: SampleType; label: string }> = [
  { type: 'P', label: 'Positive sample (P)' },
  { type: 'M', label: 'Membrane control (M)' },
  { type: 'Z', label: 'Lysis control (Z)' },
  { type: 'R', label: 'Reaction control (R)' },
  { type: 'N', label: 'Not used (N)' }
];
const COLLECTION_METHOD_OPTIONS = ['Lid8_Covaris_500639'];
const CUT_POINT_COLORS: Record<SampleType, string> = {
  P: '#38bdf8',
  M: '#f59e0b',
  Z: '#10b981',
  R: '#f87171',
  N: '#374151'
};
const PROJECT_CRYO_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444'];
const PANEL_BG = { r: 37, g: 38, b: 43 };
const ROW_TINTS: Record<SampleType, { r: number; g: number; b: number; a: number }> = {
  P: { r: 59, g: 130, b: 246, a: 0.08 },
  M: { r: 245, g: 158, b: 11, a: 0.08 },
  Z: { r: 16, g: 185, b: 129, a: 0.08 },
  R: { r: 248, g: 113, b: 113, a: 0.08 },
  N: { r: 75, g: 85, b: 99, a: 0.08 }
};
const blendChannel = (base: number, overlay: number, alpha: number) =>
  Math.round(overlay * alpha + base * (1 - alpha));
const blendWithPanel = (tint: { r: number; g: number; b: number; a: number }) =>
  `rgb(${blendChannel(PANEL_BG.r, tint.r, tint.a)}, ${blendChannel(
    PANEL_BG.g,
    tint.g,
    tint.a
  )}, ${blendChannel(PANEL_BG.b, tint.b, tint.a)})`;
const CUT_POINT_TOOLTIP_BG: Record<SampleType, string> = {
  P: blendWithPanel(ROW_TINTS.P),
  M: blendWithPanel(ROW_TINTS.M),
  Z: blendWithPanel(ROW_TINTS.Z),
  R: blendWithPanel(ROW_TINTS.R),
  N: blendWithPanel(ROW_TINTS.N)
};
const STAGE_POSITIONS = [
  {
    slide: { tl: { x: 250, y: 2212 }, br: { x: 25660, y: 77470 } },
    membrane: { tl: { x: 4962, y: 8698 }, br: { x: 21013, y: 53732 } }
  },
  {
    slide: { tl: { x: 31691.8, y: 8614.1 }, br: { x: 54204.0, y: 56202.4 } },
    membrane: { tl: { x: 33689, y: 8698 }, br: { x: 49650, y: 53658 } }
  },
  {
    slide: { tl: { x: 64978, y: 1938 }, br: { x: 90644, y: 77372 } },
    membrane: { tl: { x: 69768, y: 8658 }, br: { x: 85819, y: 53692 } }
  },
  {
    slide: { tl: { x: 93780, y: 1946 }, br: { x: 119690, y: 77465 } },
    membrane: { tl: { x: 98718, y: 8682 }, br: { x: 114760, y: 53772 } }
  }
];
const EMPTY_VIEW_MIN_Y = 10000;
const EMPTY_VIEW_MAX_Y = 50000;
const OVERVIEW_ASPECTS = [
  { label: 'Free', value: 0 },
  { label: '1:1', value: 1 },
  { label: '3:4', value: 4 / 3 },
  { label: '4:3', value: 3 / 4 },
  { label: '9:16', value: 16 / 9 },
  { label: '16:9', value: 9 / 16 }
];
const METADATA_COLUMNS: Array<{
  key: MetadataColumnKey;
  label: string;
  defaultVisible: boolean;
}> = [
  { key: 'status', label: 'Status', defaultVisible: true },
  { key: 'well', label: 'Well', defaultVisible: true },
  { key: 'plate', label: 'Plate', defaultVisible: true },
  { key: 'batch', label: 'Session', defaultVisible: false },
  { key: 'cryosection', label: 'Cryosection', defaultVisible: true },
  { key: 'sampleType', label: 'Sample Type', defaultVisible: true },
  { key: 'microsample', label: 'Microsample', defaultVisible: true },
  { key: 'number', label: 'Number', defaultVisible: false },
  { key: 'shape', label: 'Shape', defaultVisible: true },
  { key: 'collection', label: 'Collection', defaultVisible: true },
  { key: 'collectionMethod', label: 'Collection Method', defaultVisible: true },
  { key: 'images', label: 'Images', defaultVisible: true },
  { key: 'pixelx', label: 'Pixel X', defaultVisible: false },
  { key: 'pixely', label: 'Pixel Y', defaultVisible: false },
  { key: 'xcoord', label: 'Xcoord', defaultVisible: true },
  { key: 'ycoord', label: 'Ycoord', defaultVisible: true },
  { key: 'size', label: 'Size', defaultVisible: true },
  { key: 'notes', label: 'Notes', defaultVisible: true }
];
const DEFAULT_METADATA_COLUMNS = METADATA_COLUMNS.reduce(
  (acc, column) => ({ ...acc, [column.key]: column.defaultVisible }),
  {} as Record<MetadataColumnKey, boolean>
);
const DEFAULT_METADATA_COLUMN_ORDER = METADATA_COLUMNS.map((column) => column.key);
const orderMetadataColumns = <T extends { key: string }>(columns: T[], order: string[]) => {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const result: T[] = [];
  const seen = new Set<string>();
  for (const key of order) {
    const column = byKey.get(key);
    if (!column) {
      continue;
    }
    result.push(column);
    seen.add(key);
  }
  for (const column of columns) {
    if (seen.has(column.key)) {
      continue;
    }
    result.push(column);
  }
  return result;
};
const reorderMetadataColumnKeys = (order: string[], draggedKey: string, targetKey: string) => {
  if (!draggedKey || !targetKey || draggedKey === targetKey) {
    return order;
  }
  const next = order.filter((key) => key !== draggedKey);
  const targetIndex = next.indexOf(targetKey);
  if (targetIndex < 0) {
    next.push(draggedKey);
  } else {
    next.splice(targetIndex, 0, draggedKey);
  }
  return next;
};
const OVERVIEW_CONTOUR_COLORS = ['#0ea5e9', '#f97316', '#22c55e', '#a855f7', '#ef4444'];
const pickOverviewContourColor = (index: number) =>
  OVERVIEW_CONTOUR_COLORS[index % OVERVIEW_CONTOUR_COLORS.length];
const DEFAULT_FIRST_CONTOUR_NAME = 'Host tissue';
const getDefaultContourName = (index: number) =>
  index === 0 ? DEFAULT_FIRST_CONTOUR_NAME : `Contour ${index + 1}`;
const normalizeContourName = (value: string) => value.trim().replace(/\s+/g, ' ');
const getContourDisplayName = (value: string) => normalizeContourName(value) || 'Unnamed contour';
const contourNameColumnKey = (name: string) =>
  `contour-name:${normalizeContourName(name).toLowerCase()}`;
const isContourNameColumnKey = (value: string) => value.startsWith('contour-name:');
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_UI_ELEMENTS: UiElement[] = [];
const EMPTY_OVERVIEW_CONTOURS: OverviewContour[] = [];
const EMPTY_CUT_POINT_VISIBILITY: Record<string, { point: boolean; image: boolean }> = {};
const EMPTY_ORPHAN_IMAGE_VISIBILITY: Record<string, boolean> = {};
const EMPTY_COLLECTION_METADATA: CollectionMetadata = {
  collectionMethod: COLLECTION_METHOD_OPTIONS[0],
  encodingMode: 'corrected',
  date: '',
  temperature: '',
  humidity: '',
  notes: '',
  startTime: '',
  endTime: '',
  startTimeManual: false,
  endTimeManual: false
};

const getDefaultViewerBounds = (
  width: number,
  height: number,
  padding: number
): { minX: number; maxX: number; minY: number; maxY: number } => {
  const drawWidth = Math.max(1, width - padding * 2);
  const drawHeight = Math.max(1, height - padding * 2);
  const minY = EMPTY_VIEW_MIN_Y;
  const maxY = EMPTY_VIEW_MAX_Y;
  const spanY = Math.max(1, maxY - minY);
  const spanX = spanY * (drawWidth / drawHeight);
  return {
    minX: 0,
    maxX: spanX,
    minY,
    maxY
  };
};

const getDefaultCryosectionColor = (index: number) =>
  PROJECT_CRYO_COLORS[index % PROJECT_CRYO_COLORS.length];

const expandStageBounds = (
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  minimumSpan = 1000
) => {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const spanX = Math.max(bounds.maxX - bounds.minX, minimumSpan);
  const spanY = Math.max(bounds.maxY - bounds.minY, minimumSpan);
  return {
    minX: centerX - spanX / 2,
    maxX: centerX + spanX / 2,
    minY: centerY - spanY / 2,
    maxY: centerY + spanY / 2
  };
};

const normalizeCryosectionColor = (value: unknown, index: number) => {
  const color = typeof value === 'string' ? value.trim() : '';
  return /^#[0-9a-f]{6}$/i.test(color) ? color : getDefaultCryosectionColor(index);
};

const createCryosectionConfigs = (): CryosectionConfig[] =>
  Array.from({ length: MAX_CRYOSECTIONS }, (_, index) => ({
    name: '',
    color: getDefaultCryosectionColor(index),
    stagePosition: DEFAULT_STAGE_POSITION
  }));

const createPlateSegmentAssignment = (cryoIndex: number | null = null): PlateSegmentAssignment => ({
  cryoIndex,
  positiveStart: DEFAULT_MICROSAMPLE_START,
  positiveManual: false,
  negativeStart: DEFAULT_MICROSAMPLE_START,
  negativeManual: false
});

const createPlateAssignments = (): PlateAssignment[] => [
  {
    split: false,
    segments: [createPlateSegmentAssignment(null), createPlateSegmentAssignment(null)]
  },
  {
    split: false,
    segments: [createPlateSegmentAssignment(null), createPlateSegmentAssignment(null)]
  }
];

const clonePlateAssignments = (assignments: PlateAssignment[]): PlateAssignment[] =>
  Array.from({ length: MAX_PLATES }, (_, plateIndex) => {
    const assignment = assignments[plateIndex];
    if (!assignment) {
      return {
        split: false,
        segments: [createPlateSegmentAssignment(null), createPlateSegmentAssignment(null)]
      };
    }
    return {
      split: assignment.split,
      segments: assignment.segments.map((segment) => ({ ...segment })) as [
        PlateSegmentAssignment,
        PlateSegmentAssignment
      ]
    };
  });

const normalizeCryosectionCount = (value: unknown): 1 | 2 | 3 | 4 => {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (numeric === 1 || numeric === 2 || numeric === 3 || numeric === 4) {
    return numeric;
  }
  return 2;
};

const normalizePlateCount = (value: unknown): 1 | 2 => {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return numeric === 1 ? 1 : 2;
};

const createCryoStateArray = <T,>(factory: (index: number) => T): T[] =>
  Array.from({ length: MAX_CRYOSECTIONS }, (_, index) => factory(index));

const normalizeSourceFilePath = (value: string) => value.trim().replace(/\\/g, '/').toLowerCase();
const normalizeSourceFileName = (value: string) =>
  normalizeSourceFilePath(value).split('/').pop() ?? '';
const buildSourceFileNameKey = (files: string[]) =>
  files.map(normalizeSourceFileName).filter((value) => value.length > 0).sort().join('|');

const normalizeCsvSourceGroupId = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const createCsvSourceGroupId = () =>
  `csvsrc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const buildSharedCsvSourceKey = (
  files: string[],
  cryoIndex: number,
  sourceGroupId?: string | null
) => {
  const normalizedGroupId = normalizeCsvSourceGroupId(sourceGroupId);
  if (normalizedGroupId) {
    return `group:${normalizedGroupId}`;
  }
  const normalized = files
    .map(normalizeSourceFilePath)
    .filter((value) => value.length > 0)
    .sort();
  return normalized.length > 0 ? normalized.join('|') : `cryo:${cryoIndex}`;
};

const reconcileCsvSourceGroupIds = (
  csvFilesByCryo: string[][],
  currentSourceGroupIdsByCryo: Array<string | null | undefined>
) => {
  const nextSourceGroupIdsByCryo = createCryoStateArray((index) =>
    normalizeCsvSourceGroupId(currentSourceGroupIdsByCryo[index])
  );
  const cryoIndexesByPathKey = new Map<string, number[]>();

  for (let cryoIndex = 0; cryoIndex < MAX_CRYOSECTIONS; cryoIndex += 1) {
    if ((csvFilesByCryo[cryoIndex]?.length ?? 0) === 0) {
      nextSourceGroupIdsByCryo[cryoIndex] = null;
      continue;
    }
    const pathKey = buildSharedCsvSourceKey(csvFilesByCryo[cryoIndex] ?? [], cryoIndex, null);
    if (pathKey.startsWith('cryo:')) {
      continue;
    }
    const existing = cryoIndexesByPathKey.get(pathKey) ?? [];
    existing.push(cryoIndex);
    cryoIndexesByPathKey.set(pathKey, existing);
  }

  for (const cryoIndexes of cryoIndexesByPathKey.values()) {
    if (cryoIndexes.length < 2) {
      continue;
    }
    const existingGroupId = cryoIndexes
      .map((index) => nextSourceGroupIdsByCryo[index])
      .find((value): value is string => Boolean(value));
    const sharedGroupId = existingGroupId ?? createCsvSourceGroupId();
    for (const cryoIndex of cryoIndexes) {
      nextSourceGroupIdsByCryo[cryoIndex] = sharedGroupId;
    }
  }

  return nextSourceGroupIdsByCryo;
};

const getPlateSegmentColumnBounds = (assignment: PlateAssignment, segmentIndex: 0 | 1) => {
  const startCol = assignment.split && segmentIndex === 1 ? 6 : 0;
  const endCol = assignment.split && segmentIndex === 0 ? 5 : 11;
  return { startCol, endCol, width: endCol - startCol + 1 };
};

const buildCryoCsvTargets = (
  cryoIndex: number,
  plateCount: number,
  assignments: PlateAssignment[],
  csvFilesByCryo: string[][],
  csvSourceGroupIdsByCryo: Array<string | null>
) => {
  const targets: Array<{
    plateIndex: number;
    startCol: number;
    endCol: number;
    sourceStartCol: number;
    sourceEndCol: number;
  }> = [];
  const nextSourceColByKey = new Map<string, number>();
  const targetSourceKey = buildSharedCsvSourceKey(
    csvFilesByCryo[cryoIndex] ?? [],
    cryoIndex,
    csvSourceGroupIdsByCryo[cryoIndex]
  );

  for (let plateIndex = 0; plateIndex < plateCount; plateIndex += 1) {
    const assignment =
      assignments[plateIndex] ?? {
        split: false,
        segments: [createPlateSegmentAssignment(null), createPlateSegmentAssignment(null)]
      };
    const segmentIndexes: Array<0 | 1> = assignment.split ? [0, 1] : [0];
    for (const segmentIndex of segmentIndexes) {
      const segmentCryoIndex = assignment.segments[segmentIndex]?.cryoIndex;
      if (
        segmentCryoIndex === null ||
        segmentCryoIndex === undefined ||
        segmentCryoIndex < 0 ||
        segmentCryoIndex >= MAX_CRYOSECTIONS
      ) {
        continue;
      }
      const { startCol, endCol, width } = getPlateSegmentColumnBounds(assignment, segmentIndex);
      const sourceKey = buildSharedCsvSourceKey(
        csvFilesByCryo[segmentCryoIndex] ?? [],
        segmentCryoIndex,
        csvSourceGroupIdsByCryo[segmentCryoIndex]
      );
      const sourceStartCol = nextSourceColByKey.get(sourceKey) ?? 0;
      nextSourceColByKey.set(sourceKey, sourceStartCol + width);
      if (segmentCryoIndex !== cryoIndex) {
        continue;
      }
      targets.push({
        plateIndex,
        startCol,
        endCol,
        sourceStartCol,
        sourceEndCol: sourceStartCol + width - 1
      });
    }
  }

  return {
    targets,
    totalAssignedColumns: nextSourceColByKey.get(targetSourceKey) ?? 0
  };
};

const replaceAt = <T,>(items: T[], index: number, value: T): T[] => {
  const next = items.slice();
  next[index] = value;
  return next;
};

const createPlateCells = (): SampleType[][] =>
  PLATE_ROWS.map(() => PLATE_COLS.map(() => DEFAULT_SAMPLE));

const csvPlatesContainManualOrDerivedLinks = (plates: CsvCell[][][]) => {
  for (const plate of plates) {
    for (const row of plate) {
      for (const cell of row) {
        if (
          cell.manualAssigned === true ||
          cell.inferred === true ||
          cell.inferenceConfirmed === true ||
          isManualCoordinateLabel(cell.images)
        ) {
          return true;
        }
      }
    }
  }
  return false;
};

const createCollectionCells = (): CollectionCell[][] =>
  PLATE_ROWS.map(() => PLATE_COLS.map(() => ({ left: 0, right: 0, rightTouched: false })));
const createCollectionColumnAreas = (): [string[], string[]] => [
  PLATE_COLS.map(() => ''),
  PLATE_COLS.map(() => '')
];

const COLLECTION_RIGHT_MAX = 4;
const nextCollectionRight = (value: number) => (value + 1) % (COLLECTION_RIGHT_MAX + 1);
const prevCollectionRight = (value: number) =>
  (value + COLLECTION_RIGHT_MAX) % (COLLECTION_RIGHT_MAX + 1);
const getCollectionYValue = (right: number, mode: CollectionEncodingMode) =>
  mode === 'corrected' ? Math.max(0, right - 1) : right;
const getCollectionRightFromY = (y: number, mode: CollectionEncodingMode) =>
  mode === 'corrected'
    ? Math.min(COLLECTION_RIGHT_MAX, Math.max(1, y + 1))
    : Math.min(COLLECTION_RIGHT_MAX, Math.max(0, y));

const createOverviewLayer = (): OverviewLayerState => ({
  filePath: null,
  bitmap: null,
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  visible: true
});

const createOverviewState = (): OverviewState => ({
  pre: createOverviewLayer(),
  post: createOverviewLayer(),
  linked: true,
  showCutPoints: true,
  showCutImages: true,
  showOrphanImages: false,
  showMembraneControls: false,
  showPre: true,
  showPost: true,
  activeLayer: 'pre'
});

const createOverviewSelection = (): OverviewSelectionState => ({
  enabled: false,
  aspect: 1,
  rect: null,
  outputScale: 1
});

const serializeOverviewLayer = (layer: OverviewLayerState) => ({
  filePath: layer.filePath,
  offsetX: layer.offsetX,
  offsetY: layer.offsetY,
  scaleX: layer.scaleX,
  scaleY: layer.scaleY,
  visible: layer.visible
});

const serializeOverviewState = (state: OverviewState) => ({
  pre: serializeOverviewLayer(state.pre),
  post: serializeOverviewLayer(state.post),
  linked: state.linked,
  showCutPoints: state.showCutPoints,
  showCutImages: state.showCutImages,
  showOrphanImages: state.showOrphanImages,
  showMembraneControls: state.showMembraneControls,
  showPre: state.showPre,
  showPost: state.showPost,
  activeLayer: state.activeLayer
});

const serializeOverviewSelection = (state: OverviewSelectionState) => ({
  enabled: state.enabled,
  aspect: state.aspect,
  rect: state.rect,
  outputScale: state.outputScale
});

const serializeOverviewCrop = (state: OverviewCropResult) => ({
  rectPx: state.rectPx,
  cuts: state.cuts,
  layer: state.layer
});

const serializeOverviewContours = (contours: OverviewContour[]) =>
  contours.map((contour) => ({
    id: contour.id,
    name: contour.name,
    color: contour.color,
    visible: contour.visible,
    closed: contour.closed,
    points: contour.points
  }));

const snapshotOverviewState = (state: OverviewState): OverviewState => ({
  pre: { ...state.pre, bitmap: null },
  post: { ...state.post, bitmap: null },
  linked: state.linked,
  showCutPoints: state.showCutPoints,
  showCutImages: state.showCutImages,
  showOrphanImages: state.showOrphanImages,
  showMembraneControls: state.showMembraneControls,
  showPre: state.showPre,
  showPost: state.showPost,
  activeLayer: state.activeLayer
});

const restoreOverviewState = (snapshot: OverviewState, current: OverviewState): OverviewState => {
  const restoreLayer = (snap: OverviewLayerState, cur: OverviewLayerState) => ({
    ...cur,
    filePath: snap.filePath,
    offsetX: snap.offsetX,
    offsetY: snap.offsetY,
    scaleX: snap.scaleX,
    scaleY: snap.scaleY,
    visible: snap.visible,
    bitmap: snap.filePath === cur.filePath ? cur.bitmap : null
  });
  return {
    ...current,
    linked: snapshot.linked,
    showCutPoints: snapshot.showCutPoints,
    showCutImages: snapshot.showCutImages,
    showOrphanImages: snapshot.showOrphanImages,
    showMembraneControls: snapshot.showMembraneControls,
    showPre: snapshot.showPre,
    showPost: snapshot.showPost,
    activeLayer: snapshot.activeLayer,
    pre: restoreLayer(snapshot.pre, current.pre),
    post: restoreLayer(snapshot.post, current.post)
  };
};

const createCsvCells = (): CsvCell[][] => PLATE_ROWS.map(() => PLATE_COLS.map(() => ({})));

const normalizeSampleType = (value: unknown): SampleType => {
  if (value === 'P' || value === 'M' || value === 'Z' || value === 'R' || value === 'N') {
    return value;
  }
  return DEFAULT_SAMPLE;
};

const normalizePlateData = (raw: unknown, fallbackLabel: string): PlateConfig => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const labelValue =
    typeof record.label === 'string'
      ? record.label
      : typeof record.name === 'string'
        ? record.name
        : fallbackLabel;
  const leftName = typeof record.leftName === 'string' ? record.leftName : '';
  const rightName = typeof record.rightName === 'string' ? record.rightName : '';
  const notes =
    typeof record.notes === 'string'
      ? record.notes
      : typeof record.comment === 'string'
        ? record.comment
        : '';
  const cells = createPlateCells();

  if (Array.isArray(record.cells)) {
    for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
      const row = record.cells[rowIndex];
      if (!Array.isArray(row)) {
        continue;
      }
      for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
        cells[rowIndex][colIndex] = normalizeSampleType(row[colIndex]);
      }
    }
  }

  return {
    label: labelValue,
    leftName,
    rightName,
    notes,
    cells
  };
};

const formatPlateDisplayLabel = (plateIndex: number, plateBatchId: string): string => {
  const trimmed = plateBatchId.trim();
  return trimmed ? `PLATE ${plateIndex + 1} - ${trimmed}` : `PLATE ${plateIndex + 1}`;
};

const extractPlateBatchId = (label: unknown, plateIndex: number): string => {
  const value = typeof label === 'string' ? label.trim() : '';
  if (!value) {
    return '';
  }
  const match = value.match(new RegExp(`^plate\\s*${plateIndex + 1}(?:\\s*-\\s*(.*))?$`, 'i'));
  if (!match) {
    return value;
  }
  return (match[1] ?? '').trim();
};

const createDefaultDesignPlates = (): PlateConfig[] => [
  { label: formatPlateDisplayLabel(0, ''), leftName: '', rightName: '', notes: '', cells: createPlateCells() },
  { label: formatPlateDisplayLabel(1, ''), leftName: '', rightName: '', notes: '', cells: createPlateCells() }
];

const withControlSuffix = (prefix: string, sample: Extract<SampleType, 'M' | 'Z' | 'R'>): string => {
  if (!prefix) {
    return sample;
  }
  if (/[A-Za-z]$/.test(prefix)) {
    return `${prefix.slice(0, -1)}${sample}`;
  }
  return `${prefix}${sample}`;
};

const getCryosectionLabelForSample = (label: string, sample: SampleType): string => {
  if (sample === 'M' || sample === 'Z' || sample === 'R') {
    return withControlSuffix(label, sample);
  }
  return label;
};

const normalizeCollectionData = (raw: unknown): CollectionCell[][] => {
  const cells = createCollectionCells();
  if (!Array.isArray(raw)) {
    return cells;
  }
  for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
    const row = raw[rowIndex];
    if (!Array.isArray(row)) {
      continue;
    }
    for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
      const cell = row[colIndex];
      if (!cell || typeof cell !== 'object') {
        continue;
      }
      const record = cell as Record<string, unknown>;
      const leftValue =
        typeof record.left === 'number' && Number.isFinite(record.left) ? record.left : 0;
      const rightValue =
        typeof record.right === 'number' && Number.isFinite(record.right) ? record.right : 0;
      const legacyTouched = typeof record.rightTouched === 'boolean' && record.rightTouched;
      // Backward compatible migration from old 3-state mode:
      // untouched(0,false), cross(0,true), check(1,true).
      let normalizedRight = Math.min(COLLECTION_RIGHT_MAX, Math.max(0, Math.round(rightValue)));
      if (legacyTouched && normalizedRight === 0) {
        normalizedRight = 1;
      } else if (legacyTouched && normalizedRight === 1) {
        normalizedRight = 2;
      }
      cells[rowIndex][colIndex] = {
        left: Math.max(0, Math.round(leftValue)),
        right: normalizedRight,
        rightTouched: false
      };
    }
  }
  return cells;
};

const normalizeCollectionColumnAreas = (raw: unknown): [string[], string[]] => {
  const next = createCollectionColumnAreas();
  if (!Array.isArray(raw)) {
    return next;
  }
  for (let plateIndex = 0; plateIndex < 2; plateIndex += 1) {
    const row = raw[plateIndex];
    if (!Array.isArray(row)) {
      continue;
    }
    for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
      const value = row[colIndex];
      const digits = String(value ?? '')
        .replace(/\D/g, '')
        .slice(0, 4);
      next[plateIndex][colIndex] = digits;
    }
  }
  return next;
};

const normalizeOverviewLayer = (raw: unknown): OverviewLayerState => {
  const base = createOverviewLayer();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const record = raw as Record<string, unknown>;
  return {
    ...base,
    filePath: typeof record.filePath === 'string' ? record.filePath : null,
    offsetX: Number.isFinite(Number(record.offsetX)) ? Number(record.offsetX) : 0,
    offsetY: Number.isFinite(Number(record.offsetY)) ? Number(record.offsetY) : 0,
    scaleX: Number.isFinite(Number(record.scaleX)) ? Number(record.scaleX) : 1,
    scaleY: Number.isFinite(Number(record.scaleY)) ? Number(record.scaleY) : 1,
    visible: record.visible !== false
  };
};

const normalizeOverviewState = (raw: unknown): OverviewState => {
  const base = createOverviewState();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const record = raw as Record<string, unknown>;
  return {
    ...base,
    pre: normalizeOverviewLayer(record.pre),
    post: normalizeOverviewLayer(record.post),
    linked: record.linked !== false,
    showCutPoints: record.showCutPoints !== false,
    showCutImages: record.showCutImages !== false,
    showOrphanImages: record.showOrphanImages === true,
    showMembraneControls: record.showMembraneControls === true,
    showPre: record.showPre !== false,
    showPost: record.showPost !== false,
    activeLayer: record.activeLayer === 'post' ? 'post' : 'pre'
  };
};

const normalizeOverviewSelection = (raw: unknown): OverviewSelectionState => {
  const base = createOverviewSelection();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const record = raw as Record<string, unknown>;
  const rectRaw = record.rect && typeof record.rect === 'object' ? (record.rect as Record<string, unknown>) : null;
  const rect =
    rectRaw &&
    Number.isFinite(Number(rectRaw.x)) &&
    Number.isFinite(Number(rectRaw.y)) &&
    Number.isFinite(Number(rectRaw.w)) &&
    Number.isFinite(Number(rectRaw.h))
      ? {
          x: Number(rectRaw.x),
          y: Number(rectRaw.y),
          w: Number(rectRaw.w),
          h: Number(rectRaw.h)
        }
      : null;
  return {
    ...base,
    enabled: record.enabled === true,
    aspect: Number.isFinite(Number(record.aspect)) ? Number(record.aspect) : base.aspect,
    outputScale: Number.isFinite(Number(record.outputScale))
      ? Number(record.outputScale)
      : base.outputScale,
    rect
  };
};

const normalizeOverviewCrop = (raw: unknown): OverviewCropResult => {
  if (!raw || typeof raw !== 'object') {
    return { rectPx: null, cuts: [], layer: 'pre' };
  }
  const record = raw as Record<string, unknown>;
  const rectRaw = record.rectPx && typeof record.rectPx === 'object' ? (record.rectPx as Record<string, unknown>) : null;
  const rectPx =
    rectRaw &&
    Number.isFinite(Number(rectRaw.x)) &&
    Number.isFinite(Number(rectRaw.y)) &&
    Number.isFinite(Number(rectRaw.w)) &&
    Number.isFinite(Number(rectRaw.h))
      ? {
          x: Number(rectRaw.x),
          y: Number(rectRaw.y),
          w: Number(rectRaw.w),
          h: Number(rectRaw.h)
        }
      : null;
  const cutsRaw = Array.isArray(record.cuts) ? record.cuts : [];
  const cuts = cutsRaw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const cut = item as Record<string, unknown>;
      const x = Number(cut.x);
      const y = Number(cut.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      return {
        id: typeof cut.id === 'string' ? cut.id : '',
        well: typeof cut.well === 'string' ? cut.well : '',
        code: typeof cut.code === 'string' ? cut.code : undefined,
        plateLabel: typeof cut.plateLabel === 'string' ? cut.plateLabel : undefined,
        x,
        y
      };
    })
    .filter(Boolean) as Array<{ id: string; well: string; code?: string; x: number; y: number }>;
  return {
    rectPx,
    cuts,
    layer: record.layer === 'post' ? 'post' : 'pre'
  };
};

const normalizeOverviewContours = (raw: unknown): OverviewContour[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const pointsRaw = Array.isArray(record.points) ? record.points : [];
      const points = pointsRaw
        .map((point) => {
          if (!point || typeof point !== 'object') {
            return null;
          }
          const pointRecord = point as Record<string, unknown>;
          const x = Number(pointRecord.x);
          const y = Number(pointRecord.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
          }
          return { x, y };
        })
        .filter(Boolean) as Array<{ x: number; y: number }>;
      if (points.length === 0) {
        return null;
      }
      const id =
        typeof record.id === 'string' && record.id.trim()
          ? record.id
          : `contour_${Date.now()}_${index}`;
      const name =
        typeof record.name === 'string' && record.name.trim()
          ? record.name.trim()
          : getDefaultContourName(index);
      const color =
        typeof record.color === 'string' && record.color.trim()
          ? record.color
          : pickOverviewContourColor(index);
      return {
        id,
        name,
        color,
        visible: record.visible !== false,
        closed: record.closed === true,
        points
      } as OverviewContour;
    })
    .filter(Boolean) as OverviewContour[];
};

const normalizeExportSize = (raw: unknown): ExportSize => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const w = Number(record.w);
  const h = Number(record.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return { w, h };
};

const normalizeSessions = (raw: unknown, now = new Date().toISOString()): SessionEntry[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const usersRaw = Array.isArray(record.users)
        ? record.users.filter((item): item is string => typeof item === 'string')
        : [];
      const legacyUser = typeof record.user === 'string' ? record.user : '';
      const users = normalizeUserList(usersRaw.length ? usersRaw : legacyUser ? [legacyUser] : []);
      const startTime = typeof record.startTime === 'string' ? record.startTime : '';
      if (!users.length || !startTime) {
        return null;
      }
      const userLabel = formatSessionUsers(users);
      const statusRaw = record.status;
      const status =
        statusRaw === 'open' || statusRaw === 'closed' || statusRaw === 'interrupted'
          ? statusRaw
          : undefined;
      const endTime =
        typeof record.endTime === 'string' && record.endTime
          ? record.endTime
          : undefined;
      if (!endTime) {
        if (status === 'open' || !status) {
          return {
            id: typeof record.id === 'string' ? record.id : createSession(users).id,
            users,
            user: userLabel,
            startTime,
            endTime: now,
            status: 'interrupted'
          } as SessionEntry;
        }
        if (status === 'interrupted') {
          return {
            id: typeof record.id === 'string' ? record.id : createSession(users).id,
            users,
            user: userLabel,
            startTime,
            endTime: now,
            status: 'interrupted'
          } as SessionEntry;
        }
        return {
          id: typeof record.id === 'string' ? record.id : createSession(users).id,
          users,
          user: userLabel,
          startTime,
          endTime: now,
          status: 'closed'
        } as SessionEntry;
      }
      return {
        id: typeof record.id === 'string' ? record.id : createSession(users).id,
        users,
        user: userLabel,
        startTime,
        endTime,
        status: status ?? 'closed'
      } as SessionEntry;
    })
    .filter(Boolean) as SessionEntry[];
};

const normalizeHistory = (raw: unknown): HistoryEntry[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const savedAt = typeof record.savedAt === 'string' ? record.savedAt : '';
      const snapshot =
        record.snapshot && typeof record.snapshot === 'object'
          ? (record.snapshot as Record<string, unknown>)
          : null;
      if (!savedAt || !snapshot) {
        return null;
      }
      return {
        id: typeof record.id === 'string' ? record.id : createHistoryEntry(snapshot, savedAt).id,
        savedAt,
        user: typeof record.user === 'string' ? record.user : undefined,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
        snapshot
      } as HistoryEntry;
    })
    .filter(Boolean) as HistoryEntry[];
};

const normalizeCsvData = (raw: unknown): CsvCell[][] => {
  const cells = createCsvCells();
  if (!Array.isArray(raw)) {
    return cells;
  }
  for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
    const row = raw[rowIndex];
    if (!Array.isArray(row)) {
      continue;
    }
    for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
      const cell = row[colIndex];
      if (!cell || typeof cell !== 'object') {
        continue;
      }
      const record = cell as Record<string, unknown>;
      const size =
        typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined;
      const images = typeof record.images === 'string' ? record.images : undefined;
      const preImage = typeof record.preImage === 'string' ? record.preImage : undefined;
      const cutImage = typeof record.cutImage === 'string' ? record.cutImage : undefined;
      const pixelX =
        typeof record.pixelX === 'number' && Number.isFinite(record.pixelX)
          ? record.pixelX
          : undefined;
      const pixelY =
        typeof record.pixelY === 'number' && Number.isFinite(record.pixelY)
          ? record.pixelY
          : undefined;
      const sourceOrder =
        typeof record.sourceOrder === 'number' && Number.isFinite(record.sourceOrder)
          ? record.sourceOrder
          : undefined;
      const inferred = record.inferred === true;
      const inferenceConfirmed = record.inferenceConfirmed === true;
      const manualAssigned =
        record.manualAssigned === true ||
        (isManualCoordinateLabel(images) && !preImage && !cutImage);
      const presentRaw = typeof record.present === 'boolean' ? record.present : undefined;
      const present =
        presentRaw !== undefined
          ? presentRaw
          : size !== undefined ||
              !!images ||
              !!preImage ||
              !!cutImage ||
              pixelX !== undefined ||
              pixelY !== undefined;
      cells[rowIndex][colIndex] = {
        size,
        images,
        preImage,
        cutImage,
        pixelX,
        pixelY,
        sourceOrder,
        inferred,
        inferenceConfirmed,
        manualAssigned,
        present
      };
    }
  }
  return cells;
};

const normalizeCsvPlacements = (raw: unknown): CsvPlacement[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const plateIndex = Number(record.plateIndex);
      const rowIndex = Number(record.rowIndex);
      const colIndex = Number(record.colIndex);
      if (
        !Number.isInteger(plateIndex) ||
        !Number.isInteger(rowIndex) ||
        !Number.isInteger(colIndex) ||
        plateIndex < 0 ||
        rowIndex < 0 ||
        rowIndex >= PLATE_ROWS.length ||
        colIndex < 0 ||
        colIndex >= PLATE_COLS.length
      ) {
        return null;
      }
      const size =
        typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined;
      const images = typeof record.images === 'string' ? record.images : undefined;
      const preImage = typeof record.preImage === 'string' ? record.preImage : undefined;
      const cutImage = typeof record.cutImage === 'string' ? record.cutImage : undefined;
      const pixelX =
        typeof record.pixelX === 'number' && Number.isFinite(record.pixelX)
          ? record.pixelX
          : undefined;
      const pixelY =
        typeof record.pixelY === 'number' && Number.isFinite(record.pixelY)
          ? record.pixelY
          : undefined;
      const sourceOrder =
        typeof record.sourceOrder === 'number' && Number.isFinite(record.sourceOrder)
          ? record.sourceOrder
          : undefined;
      const inferred = record.inferred === true;
      const inferenceConfirmed = record.inferenceConfirmed === true;
      const manualAssigned =
        record.manualAssigned === true ||
        (isManualCoordinateLabel(images) && !preImage && !cutImage);
      const rowLetter =
        typeof record.rowLetter === 'string' && record.rowLetter.trim().length > 0
          ? record.rowLetter.trim().toUpperCase()
          : PLATE_ROWS[rowIndex];
      const presentRaw = typeof record.present === 'boolean' ? record.present : undefined;
      const present =
        presentRaw !== undefined
          ? presentRaw
          : size !== undefined ||
              !!images ||
              !!preImage ||
              !!cutImage ||
              pixelX !== undefined ||
              pixelY !== undefined;
      return {
        plateIndex,
        rowIndex,
        colIndex,
        rowLetter,
        size,
        images,
        preImage,
        cutImage,
        pixelX,
        pixelY,
        sourceOrder,
        inferred,
        inferenceConfirmed,
        manualAssigned,
        present
      } as CsvPlacement;
    })
    .filter(Boolean) as CsvPlacement[];
};

const flattenCsvPlacementsFromPlates = (plates: CsvCell[][][]): CsvPlacement[] => {
  const placements: CsvPlacement[] = [];
  for (let plateIndex = 0; plateIndex < plates.length; plateIndex += 1) {
    for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
      for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
        const cell = plates[plateIndex]?.[rowIndex]?.[colIndex];
        if (!cell?.present) {
          continue;
        }
        placements.push({
          ...cell,
          plateIndex,
          rowIndex,
          colIndex,
          rowLetter: PLATE_ROWS[rowIndex]
        });
      }
    }
  }
  placements.sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0));
  return placements;
};

const splitCsvLine = (line: string, delimiter: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current);
  return result;
};

const parseAreaValue = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(',', '.').trim();
  if (!normalized) {
    return undefined;
  }
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  return num;
};

const parseVersionParts = (value: string): [number, number, number] | null => {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10)
  ];
};

const isVersionAtMost = (value: string, ceiling: string): boolean => {
  const current = parseVersionParts(value);
  const target = parseVersionParts(ceiling);
  if (!current || !target) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (current[index] < target[index]) {
      return true;
    }
    if (current[index] > target[index]) {
      return false;
    }
  }
  return true;
};

type RawCsvRow = {
  type: string;
  areaByLetter: Record<string, string>;
  imageNames: string;
  coords: string;
};
type CollectionImportRow = {
  plate: string;
  well: string;
  area: string;
  collection: string;
};

const computeCsvIssues = (csvPlates: CsvCell[][][], plates: PlateConfig[]) => {
  const issues = { controlHasSample: 0, missingSample: 0 };
  for (let plateIndex = 0; plateIndex < csvPlates.length; plateIndex += 1) {
    for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
      for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
        const csvCell = csvPlates[plateIndex]?.[rowIndex]?.[colIndex];
        if (!csvCell || !csvCell.present) {
          continue;
        }
        const sampleType = plates[plateIndex]?.cells[rowIndex]?.[colIndex];
        if (sampleType === DISABLED_SAMPLE) {
          continue;
        }
        const hasSample = csvCell.size !== undefined && csvCell.size !== null;
        if ((sampleType === 'Z' || sampleType === 'R') && hasSample) {
          issues.controlHasSample += 1;
        }
        if (sampleType !== 'Z' && sampleType !== 'R' && !hasSample) {
          issues.missingSample += 1;
        }
      }
    }
  }
  return issues;
};

const normalizeHeaderKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');

const parseCsvText = (text: string): RawCsvRow[] => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const delimiter = lines[0].includes('\t')
    ? '\t'
    : lines[0].includes(';')
      ? ';'
      : ',';
  const header = splitCsvLine(lines[0], delimiter).map((value) => value.trim());
  const indexByKey = new Map(
    header.map((name, index) => [normalizeHeaderKey(name), index])
  );
  const typeIndex = indexByKey.get(normalizeHeaderKey('Type'));

  const areaIndices: Record<string, number | undefined> = {};
  for (const letter of PLATE_ROWS) {
    const label = normalizeHeaderKey(`${letter} (Area)`);
    areaIndices[letter] = indexByKey.get(label);
  }
  let imageIndex =
    indexByKey.get(normalizeHeaderKey('Image Name(s)')) ??
    indexByKey.get(normalizeHeaderKey('Image Name'));
  if (imageIndex === undefined) {
    const fallback = header.findIndex((name) => {
      const key = normalizeHeaderKey(name);
      return key.includes('image') && key.includes('name');
    });
    imageIndex = fallback >= 0 ? fallback : undefined;
  }

  let coordIndex =
    indexByKey.get(normalizeHeaderKey('X/Y Coordinates')) ??
    indexByKey.get(normalizeHeaderKey('XY Coordinates'));
  if (coordIndex === undefined) {
    const fallback = header.findIndex((name) => {
      const key = normalizeHeaderKey(name);
      return key.includes('coord') && key.includes('xy');
    });
    coordIndex = fallback >= 0 ? fallback : undefined;
  }

  const rows: RawCsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCsvLine(lines[i], delimiter);
    if (cols.length === 0) {
      continue;
    }
    const first = cols[0]?.trim().toLowerCase();
    if (first === 'sum') {
      continue;
    }
    const areaByLetter: Record<string, string> = {};
    for (const letter of PLATE_ROWS) {
      const idx = areaIndices[letter];
      areaByLetter[letter] = idx !== undefined ? (cols[idx] ?? '').trim() : '';
    }
    rows.push({
      type: typeIndex !== undefined ? (cols[typeIndex] ?? '').trim() : '',
      areaByLetter,
      imageNames: imageIndex !== undefined ? (cols[imageIndex] ?? '').trim() : '',
      coords: coordIndex !== undefined ? (cols[coordIndex] ?? '').trim() : ''
    });
  }
  return rows;
};

const parseCollectionImportCsv = (text: string): CollectionImportRow[] => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const delimiter = lines[0].includes('\t')
    ? '\t'
    : lines[0].includes(';')
      ? ';'
      : ',';
  const header = splitCsvLine(lines[0], delimiter).map((value) => value.trim());
  const indexByKey = new Map(header.map((name, index) => [normalizeHeaderKey(name), index]));
  const getHeaderIndex = (...candidates: string[]) => {
    for (const candidate of candidates) {
      const index = indexByKey.get(normalizeHeaderKey(candidate));
      if (index !== undefined) {
        return index;
      }
    }
    return undefined;
  };
  const plateIndex = getHeaderIndex('Plate', 'LMBatch');
  const wellIndex = getHeaderIndex('Well', 'PlatePosition');
  const areaIndex = getHeaderIndex('Area', 'Size');
  const collectionIndex = getHeaderIndex('Collection', 'Notes Collection');

  if (
    plateIndex === undefined ||
    wellIndex === undefined ||
    areaIndex === undefined ||
    collectionIndex === undefined
  ) {
    throw new Error(
      'Collection CSV must contain Plate/LMBatch, Well/PlatePosition, Area/Size and Collection/Notes Collection columns.'
    );
  }

  const rows: CollectionImportRow[] = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const cols = splitCsvLine(lines[lineIndex], delimiter);
    const row: CollectionImportRow = {
      plate: (cols[plateIndex] ?? '').trim(),
      well: (cols[wellIndex] ?? '').trim(),
      area: (cols[areaIndex] ?? '').trim(),
      collection: (cols[collectionIndex] ?? '').trim()
    };
    if (!row.plate && !row.well && !row.area && !row.collection) {
      continue;
    }
    rows.push(row);
  }
  return rows;
};

const parseCollectionImportWell = (value: string): { rowIndex: number; colIndex: number } | null => {
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) {
    return null;
  }
  const letterFirst = trimmed.match(/^([A-H])\s*(1[0-2]|[1-9])$/);
  if (letterFirst) {
    return {
      rowIndex: PLATE_ROWS.indexOf(letterFirst[1]),
      colIndex: Number.parseInt(letterFirst[2], 10) - 1
    };
  }
  const numberFirst = trimmed.match(/^(1[0-2]|[1-9])\s*([A-H])$/);
  if (numberFirst) {
    return {
      rowIndex: PLATE_ROWS.indexOf(numberFirst[2]),
      colIndex: Number.parseInt(numberFirst[1], 10) - 1
    };
  }
  return null;
};

const formatWellDisplay = (value: string): string => {
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) {
    return value;
  }
  const numberFirst = trimmed.match(/^(1[0-2]|[1-9])([A-H])$/);
  if (numberFirst) {
    return `${numberFirst[1]}${numberFirst[2]}`;
  }
  const letterFirst = trimmed.match(/^([A-H])(1[0-2]|[1-9])$/);
  if (letterFirst) {
    return `${letterFirst[2]}${letterFirst[1]}`;
  }
  return value;
};

const parseCollectionImportCounts = (
  value: string,
  mode: CollectionEncodingMode
): CollectionCell | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return { left: 0, right: 0, rightTouched: false };
  }
  const match = trimmed.match(/^c\s*(\d+)\s*y\s*(\d+)$/i);
  if (!match) {
    return null;
  }
  const left = Number.parseInt(match[1], 10);
  const right = Number.parseInt(match[2], 10);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return null;
  }
  return {
    left: Math.max(0, left),
    right: getCollectionRightFromY(right, mode),
    rightTouched: false
  };
};

const detectRowLetter = (row: RawCsvRow): string | undefined => {
  const lettersWithValues = PLATE_ROWS.filter((letter) => row.areaByLetter[letter]?.trim());
  if (lettersWithValues.length === 1) {
    return lettersWithValues[0];
  }
  if (lettersWithValues.length > 1) {
    return lettersWithValues[0];
  }
  return undefined;
};

const isIgnoredCsvRow = (row: RawCsvRow): boolean => {
  const normalizedType = row.type.trim().toLowerCase();
  if (normalizedType && normalizedType !== 'ellipse') {
    return true;
  }
  return PLATE_ROWS.some((letter) => {
    const areaValue = parseAreaValue(row.areaByLetter[letter]);
    return areaValue !== undefined && areaValue <= 0;
  });
};

const parseCoords = (value: string): { x?: number; y?: number } => {
  const parts = value
    .split(/[/,;xX ]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return {};
  }
  const x = Number.parseFloat(parts[0].replace(',', '.'));
  const y = Number.parseFloat(parts[1].replace(',', '.'));
  return {
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined
  };
};

const parseImageNames = (value: string | undefined): { preImage?: string; cutImage?: string } => {
  if (!value) {
    return {};
  }
  const parts = value
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  let preImage: string | undefined;
  let cutImage: string | undefined;
  for (const part of parts) {
    const normalized = normalizeImageName(part);
    if (!preImage && normalized.includes('pre_wil')) {
      preImage = part;
      continue;
    }
    if (!cutImage && normalized.includes('cut_wol')) {
      cutImage = part;
    }
  }
  if (!preImage && parts[0] && !normalizeImageName(parts[0]).includes('cut_wol')) {
    preImage = parts[0];
  }
  if (!cutImage && parts.length > 1) {
    cutImage =
      parts.find((part) => normalizeImageName(part) !== normalizeImageName(preImage)) ?? parts[1];
  }
  return { preImage, cutImage };
};

const joinImageNames = (preImage?: string, cutImage?: string): string =>
  [preImage, cutImage].filter((value): value is string => Boolean(value && value.trim())).join(', ');

const getCsvLinkedImageNames = (cell: Pick<CsvCell, 'preImage' | 'cutImage'>) => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of [cell.preImage, cell.cutImage]) {
    const name = raw?.trim();
    if (!name) {
      continue;
    }
    const normalized = normalizeImageName(name);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    names.push(name);
  }
  return names;
};

const isSingleLinkedImageCsvCell = (cell: Pick<CsvCell, 'preImage' | 'cutImage' | 'images' | 'manualAssigned'>) =>
  cell.manualAssigned !== true &&
  !isManualCoordinateLabel(cell.images) &&
  getCsvLinkedImageNames(cell).length === 1;

const hasCsvCellData = (cell: CsvCell): boolean =>
  cell.size !== undefined ||
  !!cell.images ||
  !!cell.preImage ||
  !!cell.cutImage ||
  cell.pixelX !== undefined ||
  cell.pixelY !== undefined;

const cloneCsvPlatesByCryo = (value: CsvCell[][][][]): CsvCell[][][][] =>
  value.map((plates) => plates.map((plate) => plate.map((row) => row.map((cell) => ({ ...cell })))));

const cloneCsvPlacementsByCryo = (value: CsvPlacement[][]): CsvPlacement[][] =>
  value.map((placements) => placements.map((item) => ({ ...item })));

const extractImageSequence = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const match = value.trim().match(/(\d+)(?!.*\d)/);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getCsvCellImageSequenceRange = (
  cell: Pick<CsvCell, 'preImage' | 'cutImage' | 'images' | 'manualAssigned'>
): { min: number; max: number } | null => {
  if (isSingleLinkedImageCsvCell(cell) || cell.manualAssigned === true || isManualCoordinateLabel(cell.images)) {
    return null;
  }
  const sequences = [extractImageSequence(cell.preImage), extractImageSequence(cell.cutImage)].filter(
    (value): value is number => value !== undefined
  );
  if (sequences.length === 0) {
    return null;
  }
  return {
    min: Math.min(...sequences),
    max: Math.max(...sequences)
  };
};

const normalizeImageName = (value: string | undefined): string => {
  if (!value) {
    return '';
  }
  return value.trim().replace(/^"|"$|^'|'$/g, '').toLowerCase();
};

function classifyElementName(name: string): ElementGroup {
  const lower = name.toLowerCase();
  if (lower.includes('pre_wil')) {
    return 'pre';
  }
  if (lower.includes('cut_wol')) {
    return 'post';
  }
  if (lower.includes('ins_wol')) {
    return 'other';
  }
  return 'other';
}

const orphanAssignmentTargetKey = (target: OrphanAssignmentTarget): string =>
  `${target.plateIndex}-${target.rowIndex}-${target.colIndex}`;

const orphanAssignmentImageKey = (imageName: string): string =>
  normalizeImageName(imageName) || imageName;

function OrphanAssignmentPreviewCard({
  title,
  imageName,
  thumb,
  loading,
  error,
  cutPixelX,
  cutPixelY,
  originalImageWidth,
  originalImageHeight,
  stageX,
  stageY,
  checked,
  disabled,
  onToggle
}: {
  title: string;
  imageName?: string;
  thumb?: ThumbState;
  loading: boolean;
  error?: string;
  cutPixelX?: number;
  cutPixelY?: number;
  originalImageWidth?: number;
  originalImageHeight?: number;
  stageX?: number;
  stageY?: number;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#11151b';
      ctx.fillRect(0, 0, width, height);

      if (!thumb) {
        return;
      }

      const scale = Math.min(width / thumb.width, height / thumb.height);
      const drawWidth = thumb.width * scale;
      const drawHeight = thumb.height * scale;
      const offsetX = (width - drawWidth) / 2;
      const offsetY = (height - drawHeight) / 2;
      const imageWidth = Math.max(1, originalImageWidth ?? thumb.width);
      const imageHeight = Math.max(1, originalImageHeight ?? thumb.height);

      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(thumb.canvas, offsetX, offsetY, drawWidth, drawHeight);

      if (cutPixelX === undefined || cutPixelY === undefined) {
        return;
      }

      const markerX =
        offsetX +
        (Math.max(0, Math.min(imageWidth - 1, cutPixelX)) / Math.max(1, imageWidth - 1)) *
          drawWidth;
      const markerY =
        offsetY +
        (Math.max(0, Math.min(imageHeight - 1, cutPixelY)) / Math.max(1, imageHeight - 1)) *
          drawHeight;
      const radius = Math.max(8, Math.min(24, Math.min(drawWidth, drawHeight) * 0.14));

      ctx.fillStyle = 'rgba(59, 130, 246, 0.32)';
      ctx.beginPath();
      ctx.arc(markerX, markerY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.95)';
      ctx.lineWidth = Math.max(1.25, radius * 0.08);
      ctx.beginPath();
      ctx.arc(markerX, markerY, radius, 0, Math.PI * 2);
      ctx.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [cutPixelX, cutPixelY, originalImageHeight, originalImageWidth, thumb]);

  const hasImage = Boolean(imageName);
  const isDisabled = disabled || !hasImage;

  return (
    <button
      type="button"
      className={`orphan-preview-card${checked ? ' selected' : ''}${isDisabled ? ' disabled' : ''}`}
      disabled={isDisabled}
      onClick={onToggle}
    >
      <div className="orphan-preview-head">
        <div className="orphan-preview-title-group">
          <div className="orphan-preview-title">{title}</div>
          <div className="orphan-preview-name" title={imageName || 'No image available'}>
            {imageName || 'No image available'}
          </div>
        </div>
        <span className="orphan-preview-state">{checked ? 'Selected' : 'Click to use'}</span>
      </div>
      <div ref={containerRef} className="orphan-preview-canvas-shell">
        <canvas ref={canvasRef} className="orphan-preview-canvas" />
        {loading ? <div className="orphan-preview-overlay">Loading image...</div> : null}
        {!loading && (error || !hasImage) ? (
          <div className="orphan-preview-overlay">{error || 'No linked image available.'}</div>
        ) : null}
      </div>
      <div className="orphan-preview-coordinates">
        {stageX !== undefined && stageY !== undefined ? (
          <>
            <span>X {formatStageValue(stageX)}</span>
            <span>Y {formatStageValue(stageY)}</span>
          </>
        ) : (
          <span>Stage coordinates unavailable</span>
        )}
      </div>
    </button>
  );
}

export default function App(): JSX.Element {
  const [projectName, setProjectName] = useState('New session');
  const [projectDescription, setProjectDescription] = useState('');
  const [cryosectionCount, setCryosectionCount] = useState<1 | 2 | 3 | 4>(2);
  const [cryosections, setCryosections] = useState<CryosectionConfig[]>(createCryosectionConfigs);
  const [plateCount, setPlateCount] = useState<1 | 2>(2);
  const [plateBatchIds, setPlateBatchIds] = useState<[string, string]>(['', '']);
  const [plateAssignments, setPlateAssignments] = useState<PlateAssignment[]>(createPlateAssignments);
  const [selectedProjectSegment, setSelectedProjectSegment] = useState<{
    plateIndex: number;
    segmentIndex: 0 | 1;
  } | null>({ plateIndex: 0, segmentIndex: 0 });
  const [activeCryosection, setActiveCryosection] = useState(0);
  const [coordinateFrameMode, setCoordinateFrameMode] = useState<'images' | 'cut-points'>(
    'images'
  );
  const [lifFilesByCryo, setLifFilesByCryo] = useState<string[][]>(() =>
    createCryoStateArray(() => [])
  );
  const [elementsByCryo, setElementsByCryo] = useState<UiElement[][]>(() =>
    createCryoStateArray(() => [])
  );
  const [csvFilesByCryo, setCsvFilesByCryo] = useState<string[][]>(() =>
    createCryoStateArray(() => [])
  );
  const [csvSourceGroupIdsByCryo, setCsvSourceGroupIdsByCryo] = useState<Array<string | null>>(() =>
    createCryoStateArray(() => null)
  );
  const [csvPlatesByCryo, setCsvPlatesByCryo] = useState<CsvCell[][][][]>(() =>
    createCryoStateArray(() => [createCsvCells(), createCsvCells()])
  );
  const [csvPlacementsByCryo, setCsvPlacementsByCryo] = useState<CsvPlacement[][]>(() =>
    createCryoStateArray(() => [])
  );
  const [selectedIdByCryo, setSelectedIdByCryo] = useState<Array<string | null>>(() =>
    createCryoStateArray(() => null)
  );
  const [selectedIdsByCryo, setSelectedIdsByCryo] = useState<Array<Set<string>>>(() =>
    createCryoStateArray(() => new Set())
  );
  const [selectedCutIdsByCryo, setSelectedCutIdsByCryo] = useState<Array<Set<string>>>(() =>
    createCryoStateArray(() => new Set())
  );
  const [hoveredCutPointId, setHoveredCutPointId] = useState<string | null>(null);
  const [overviewHoveredCutPointId, setOverviewHoveredCutPointId] = useState<string | null>(null);
  const [selectedPlateCells, setSelectedPlateCells] = useState<Set<string>>(() => new Set());
  const [, setStatus] = useState<string>(EMPTY_STATE);
  const [, setError] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [designLocked, setDesignLocked] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'project' | 'design' | 'viewer' | 'metadata' | 'collection' | 'overview'
  >('project');
  const [imageOpacity, setImageOpacity] = useState(1);
  const [micronsPerPixel, setMicronsPerPixel] = useState(DEFAULT_MICRONS_PER_PIXEL);
  const [showCutPoints, setShowCutPoints] = useState(true);
  const [filterPre, setFilterPre] = useState(true);
  const [filterPost, setFilterPost] = useState(true);
  const [showCutLabels, setShowCutLabels] = useState(false);
  const [designPlates, setDesignPlates] = useState<PlateConfig[]>(createDefaultDesignPlates);
  const [collapsedPlates, setCollapsedPlates] = useState<[boolean, boolean]>([true, true]);
  const [collectionPlateNotes, setCollectionPlateNotes] = useState<[string, string]>(['', '']);
  const [collectionColumnAreas, setCollectionColumnAreas] =
    useState<[string[], string[]]>(createCollectionColumnAreas);
  const [collectionColumnWarning, setCollectionColumnWarning] = useState<{
    plateIndex: number;
    message: string;
  } | null>(null);
  const [collectionAreaHint, setCollectionAreaHint] = useState<string | null>(null);
  const [collectionMetadata, setCollectionMetadata] =
    useState<CollectionMetadata>(EMPTY_COLLECTION_METADATA);
  const [collectionPlates, setCollectionPlates] = useState<CollectionCell[][][]>([
    createCollectionCells(),
    createCollectionCells()
  ]);
  const [coordinatesReady, setCoordinatesReady] = useState(false);
  const [coordinateCache, setCoordinateCache] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [coordinateOverridesByCryo, setCoordinateOverridesByCryo] = useState<
    Array<Record<string, true>>
  >(() => createCryoStateArray(() => ({})));
  const [cutPointVisibilityByCryo, setCutPointVisibilityByCryo] = useState<
    Array<Record<string, { point: boolean; image: boolean }>>
  >(() => createCryoStateArray(() => ({})));
  const [orphanImageVisibilityByCryo, setOrphanImageVisibilityByCryo] = useState<
    Array<Record<string, boolean>>
  >(() => createCryoStateArray(() => ({})));
  const [coordDebug, setCoordDebug] = useState<string>('');
  const [hoveredOrphanImageId, setHoveredOrphanImageId] = useState<string | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string>('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(true);
  const [syncSnapshotOnNext, setSyncSnapshotOnNext] = useState(false);
  const [availableUsers, setAvailableUsers] = useState<string[]>(DEFAULT_SESSION_USERS);
  const [selectedSessionUsers, setSelectedSessionUsers] = useState<string[]>([]);
  const [newUserInput, setNewUserInput] = useState('');
  const [userPromptOpen, setUserPromptOpen] = useState(true);
  const [pendingAction, setPendingAction] = useState<'new' | 'load' | null>(null);
  const [legacyCollectionPrompt, setLegacyCollectionPrompt] = useState<null | {
    version: string;
  }>(null);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [projectHistory, setProjectHistory] = useState<HistoryEntry[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [metadataSearch, setMetadataSearch] = useState('');
  const [metadataSearchScope, setMetadataSearchScope] = useState<MetadataSearchScope>('all');
  const [cutPointSearch, setCutPointSearch] = useState('');
  const [showCoordinateOrphanPreImages, setShowCoordinateOrphanPreImages] = useState(true);
  const [showCoordinateOrphanPostImages, setShowCoordinateOrphanPostImages] = useState(true);
  const [coordinateOrphanCollectorFilter, setCoordinateOrphanCollectorFilter] =
    useState<string>('all');
  const [statusPrompt, setStatusPrompt] = useState<null | {
    plateIndex: number;
    rowIndex: number;
    colIndex: number;
    cryoIndex: number;
    well: string;
    code?: string;
    images: string;
    pixelX?: number;
    pixelY?: number;
    xCoord?: number;
    yCoord?: number;
    inferred: boolean;
    inferenceConfirmed: boolean;
    manualAssigned: boolean;
    coordStatus: 'ok' | 'bad' | 'pending' | 'warn';
  }>(null);
  const [orphanAssignmentPrompt, setOrphanAssignmentPrompt] =
    useState<OrphanAssignmentPromptState | null>(null);
  const [manualCoordinatePrompt, setManualCoordinatePrompt] =
    useState<ManualCoordinatePromptState | null>(null);
  const [detachCryoPromptOpen, setDetachCryoPromptOpen] = useState(false);
  const [selectedOrphanAssignmentTargetKey, setSelectedOrphanAssignmentTargetKey] = useState<
    string | null
  >(null);
  const [selectedManualCoordinateTargetKey, setSelectedManualCoordinateTargetKey] = useState<
    string | null
  >(null);
  const [manualCoordinateDrafts, setManualCoordinateDrafts] = useState({
    x: '',
    y: '',
    size: '5000'
  });
  const [selectedOrphanAssignmentImageKeys, setSelectedOrphanAssignmentImageKeys] = useState<
    string[]
  >([]);
  const [showAllOrphanAssignmentImages, setShowAllOrphanAssignmentImages] = useState(false);
  const [orphanAssignmentPreviewState, setOrphanAssignmentPreviewState] = useState<
    Record<string, OrphanAssignmentPreviewState>
  >({});
  const [overviewVisibilityCollapsed, setOverviewVisibilityCollapsed] = useState(false);
  const [overviewAlignmentCollapsed, setOverviewAlignmentCollapsed] = useState(false);
  const [overviewContourCollapsed, setOverviewContourCollapsed] = useState(false);
  const [overviewAlignmentImportSource, setOverviewAlignmentImportSource] = useState<number | null>(
    null
  );
  const [coordinatesFiltersCollapsed, setCoordinatesFiltersCollapsed] = useState(false);
  const [coordinatesSelectionCollapsed, setCoordinatesSelectionCollapsed] = useState(false);
  const [coordinatesOrphansCollapsed, setCoordinatesOrphansCollapsed] = useState(false);
  const [coordinatesReuseSource, setCoordinatesReuseSource] = useState<number | null>(null);
  const [coordinatesReuseMenuOpen, setCoordinatesReuseMenuOpen] = useState(false);
  const [metadataPlate1, setMetadataPlate1] = useState(true);
  const [metadataPlate2, setMetadataPlate2] = useState(true);
  const [metadataCryoFilters, setMetadataCryoFilters] = useState<boolean[]>(() =>
    createCryoStateArray(() => true)
  );
  const [metadataP, setMetadataP] = useState(true);
  const [metadataM, setMetadataM] = useState(true);
  const [metadataZ, setMetadataZ] = useState(true);
  const [metadataR, setMetadataR] = useState(true);
  const [metadataN, setMetadataN] = useState(true);
  const [collectionPlateLocks, setCollectionPlateLocks] = useState<[boolean, boolean]>([
    false,
    false
  ]);
  const [metadataColumns, setMetadataColumns] =
    useState<Record<MetadataColumnKey, boolean>>(() => ({ ...DEFAULT_METADATA_COLUMNS }));
  const [metadataColumnOrder, setMetadataColumnOrder] = useState<string[]>(() => [
    ...DEFAULT_METADATA_COLUMN_ORDER
  ]);
  const [metadataColumnsPopupOpen, setMetadataColumnsPopupOpen] = useState(false);
  const [metadataFiltersPopupOpen, setMetadataFiltersPopupOpen] = useState(false);
  const [metadataExportPopupOpen, setMetadataExportPopupOpen] = useState(false);
  const [coordinatesCryosectionMenuOpen, setCoordinatesCryosectionMenuOpen] = useState(false);
  const [overviewCryosectionMenuOpen, setOverviewCryosectionMenuOpen] = useState(false);
  const [metadataExportColumns, setMetadataExportColumns] = useState<Record<string, boolean>>({});
  const [metadataExportOrder, setMetadataExportOrder] = useState<string[]>([]);
  const [draggedMetadataColumnKey, setDraggedMetadataColumnKey] = useState<string | null>(null);
  const [draggedMetadataExportKey, setDraggedMetadataExportKey] = useState<string | null>(null);
  const [metadataNotes, setMetadataNotes] = useState<Record<string, string>>({});
  const [randomAssignmentSettings, setRandomAssignmentSettings] =
    useState<RandomAssignmentSettings>({
      M: 2,
      Z: 2,
      R: 2,
      maxControlsPerColumn: 1,
      sustainabilityMode: true
    });
  const [randomParamsOpen, setRandomParamsOpen] = useState(false);
  const [thumbProgress, setThumbProgress] = useState<{ total: number; done: number } | null>(
    null
  );
  const [overviewByCryo, setOverviewByCryo] = useState<OverviewState[]>(() =>
    createCryoStateArray(() => createOverviewState())
  );
  const [overviewSelectionByCryo, setOverviewSelectionByCryo] = useState<
    OverviewSelectionState[]
  >(() => createCryoStateArray(() => createOverviewSelection()));
  const [overviewCropByCryo, setOverviewCropByCryo] = useState<OverviewCropResult[]>(() =>
    createCryoStateArray(() => ({ rectPx: null, cuts: [], layer: 'pre' }))
  );
  const [overviewContoursByCryo, setOverviewContoursByCryo] = useState<OverviewContour[][]>(() =>
    createCryoStateArray(() => [])
  );
  const [activeOverviewContourByCryo, setActiveOverviewContourByCryo] = useState<
    Array<string | null>
  >(() => createCryoStateArray(() => null));
  const [activeOverviewContourAnchorByCryo, setActiveOverviewContourAnchorByCryo] = useState<
    Array<{ contourId: string; pointIndex: number } | null>
  >(() => createCryoStateArray(() => null));
  const [hoveredOverviewContourAnchorByCryo, setHoveredOverviewContourAnchorByCryo] = useState<
    Array<{ contourId: string; pointIndex: number } | null>
  >(() => createCryoStateArray(() => null));
  const [overviewContourInsertPreviewByCryo, setOverviewContourInsertPreviewByCryo] = useState<
    Array<{ contourId: string; pointIndex: number; x: number; y: number } | null>
  >(() => createCryoStateArray(() => null));
  const [overviewContourPreviewByCryo, setOverviewContourPreviewByCryo] = useState<
    Array<{ x: number; y: number } | null>
  >(() => createCryoStateArray(() => null));
  const [overviewExportByCryo, setOverviewExportByCryo] = useState<ExportSize[]>(() =>
    createCryoStateArray(() => null)
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(USER_DIRECTORY_KEY);
      if (!raw) {
        setAvailableUsers(DEFAULT_SESSION_USERS);
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setAvailableUsers(DEFAULT_SESSION_USERS);
        return;
      }
      const values = parsed
        .filter((item): item is string => typeof item === 'string')
        .filter((item) => item.trim() !== 'Nanna Guan');
      const mergedWithoutNanna = normalizeUserList([...DEFAULT_SESSION_USERS, ...values]).filter(
        (item) => item !== 'Nanna Gaun'
      );
      const merged = [...mergedWithoutNanna, 'Nanna Gaun'];
      setAvailableUsers(merged.length ? merged : DEFAULT_SESSION_USERS);
    } catch {
      setAvailableUsers(DEFAULT_SESSION_USERS);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(USER_DIRECTORY_KEY, JSON.stringify(availableUsers));
    } catch {
      // local storage is best effort only
    }
  }, [availableUsers]);

  useEffect(() => {
    if (!metadataColumnsPopupOpen && !metadataFiltersPopupOpen) {
      return;
    }
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const inColumnsPopup = metadataColumnsPopupRef.current?.contains(target);
      const inColumnsButton = metadataColumnsButtonRef.current?.contains(target);
      const inFiltersPopup = metadataFiltersPopupRef.current?.contains(target);
      const inFiltersButton = metadataFiltersButtonRef.current?.contains(target);
      if (inColumnsPopup || inColumnsButton || inFiltersPopup || inFiltersButton) {
        return;
      }
      setMetadataColumnsPopupOpen(false);
      setMetadataFiltersPopupOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [metadataColumnsPopupOpen, metadataFiltersPopupOpen]);

  useEffect(() => {
    if (!coordinatesCryosectionMenuOpen && !coordinatesReuseMenuOpen && !overviewCryosectionMenuOpen) {
      return;
    }
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const inCoordinatesMenu = coordinatesCryosectionMenuRef.current?.contains(target);
      const inCoordinatesReuseMenu = coordinatesReuseMenuRef.current?.contains(target);
      const inOverviewMenu = overviewCryosectionMenuRef.current?.contains(target);
      if (inCoordinatesMenu || inCoordinatesReuseMenu || inOverviewMenu) {
        return;
      }
      setCoordinatesCryosectionMenuOpen(false);
      setCoordinatesReuseMenuOpen(false);
      setOverviewCryosectionMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [coordinatesCryosectionMenuOpen, coordinatesReuseMenuOpen, overviewCryosectionMenuOpen]);

  useEffect(() => {
    if (
      activeTab !== 'metadata' &&
      (metadataColumnsPopupOpen || metadataFiltersPopupOpen || metadataExportPopupOpen)
    ) {
      setMetadataColumnsPopupOpen(false);
      setMetadataFiltersPopupOpen(false);
      setMetadataExportPopupOpen(false);
    }
  }, [activeTab, metadataColumnsPopupOpen, metadataFiltersPopupOpen, metadataExportPopupOpen]);

  useEffect(() => {
    if (activeTab !== 'viewer' && coordinatesCryosectionMenuOpen) {
      setCoordinatesCryosectionMenuOpen(false);
    }
    if (activeTab !== 'viewer' && coordinatesReuseMenuOpen) {
      setCoordinatesReuseMenuOpen(false);
    }
    if (activeTab !== 'overview' && overviewCryosectionMenuOpen) {
      setOverviewCryosectionMenuOpen(false);
    }
  }, [activeTab, coordinatesCryosectionMenuOpen, coordinatesReuseMenuOpen, overviewCryosectionMenuOpen]);

  useEffect(() => {
    if (activeTab !== 'viewer' && orphanAssignmentPrompt) {
      setOrphanAssignmentPrompt(null);
    }
  }, [activeTab, orphanAssignmentPrompt]);

  useEffect(() => {
    if (activeTab !== 'viewer' && manualCoordinatePrompt) {
      setManualCoordinatePrompt(null);
    }
  }, [activeTab, manualCoordinatePrompt]);

  useEffect(() => {
    if (activeTab !== 'metadata' && statusPrompt) {
      setStatusPrompt(null);
    }
  }, [activeTab, statusPrompt]);

  useEffect(() => {
    const onMouseUp = () => {
      if (!designSelectionRef.current.isSelecting) {
        return;
      }
      if (designSelectionRef.current.dragged) {
        designSelectionRef.current.suppressNextClear = true;
      }
      designSelectionRef.current.isSelecting = false;
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, []);

  const visiblePlateCount = plateCount;
  const visiblePlateIndexes = useMemo(
    () => Array.from({ length: plateCount }, (_, index) => index),
    [plateCount]
  );
  const getPlateAssignment = useCallback(
    (plateIndex: number): PlateAssignment =>
      plateAssignments[plateIndex] ?? {
        split: false,
        segments: [createPlateSegmentAssignment(null), createPlateSegmentAssignment(null)]
      },
    [plateAssignments]
  );
  const isPlateSplit = useCallback(
    (plateIndex: number) => getPlateAssignment(plateIndex).split,
    [getPlateAssignment]
  );
  const getSegmentIndexForColumn = useCallback(
    (plateIndex: number, colIndex: number): 0 | 1 =>
      isPlateSplit(plateIndex) && colIndex >= 6 ? 1 : 0,
    [isPlateSplit]
  );
  const getCellCryoIndex = useCallback(
    (plateIndex: number, colIndex: number) =>
      getPlateAssignment(plateIndex).segments[getSegmentIndexForColumn(plateIndex, colIndex)]
        ?.cryoIndex ?? null,
    [getPlateAssignment, getSegmentIndexForColumn]
  );
  const configuredCryosectionIndexes = useMemo(() => {
    const result: number[] = [];
    for (let plateIndex = 0; plateIndex < plateCount; plateIndex += 1) {
      const assignment = getPlateAssignment(plateIndex);
      const segmentIndexes: Array<0 | 1> = assignment.split ? [0, 1] : [0];
      for (const segmentIndex of segmentIndexes) {
        const cryoIndex = assignment.segments[segmentIndex]?.cryoIndex;
        if (
          cryoIndex === null ||
          cryoIndex === undefined ||
          cryoIndex < 0 ||
          cryoIndex >= cryosectionCount ||
          result.includes(cryoIndex)
        ) {
          continue;
        }
        result.push(cryoIndex);
      }
    }
    return result;
  }, [plateCount, getPlateAssignment, cryosectionCount]);
  const assignedCryosectionIndexes = useMemo(
    () =>
      configuredCryosectionIndexes.length > 0
        ? configuredCryosectionIndexes
        : Array.from({ length: cryosectionCount }, (_, index) => index).slice(0, 1),
    [configuredCryosectionIndexes, cryosectionCount]
  );
  const selectableCryosectionIndexes = useMemo(
    () => Array.from({ length: cryosectionCount }, (_, index) => index),
    [cryosectionCount]
  );
  const coordinatesReuseOptions = useMemo(
    () => selectableCryosectionIndexes.filter((index) => index !== activeCryosection),
    [activeCryosection, selectableCryosectionIndexes]
  );
  useEffect(() => {
    if (
      coordinatesReuseSource !== null &&
      coordinatesReuseOptions.some((index) => index === coordinatesReuseSource)
    ) {
      return;
    }
    setCoordinatesReuseSource(coordinatesReuseOptions[0] ?? null);
  }, [coordinatesReuseOptions, coordinatesReuseSource]);

  useEffect(() => {
    if (!coordinatesReuseOptions.length) {
      setCoordinatesReuseMenuOpen(false);
    }
  }, [coordinatesReuseOptions]);
  const overviewAlignmentImportOptions = useMemo(
    () => selectableCryosectionIndexes.filter((index) => index !== activeCryosection),
    [activeCryosection, selectableCryosectionIndexes]
  );
  const projectType: ProjectType = useMemo(() => {
    const plate0 = getPlateAssignment(0);
    const plate1 = getPlateAssignment(1);
    if (
      plateCount === 1 &&
      !plate0.split &&
      configuredCryosectionIndexes.length <= 1
    ) {
      return 'One plate one cryosection';
    }
    if (
      plateCount === 1 &&
      plate0.split &&
      configuredCryosectionIndexes.length === 2
    ) {
      return 'One plate two cryosections';
    }
    if (
      plateCount === 2 &&
      plate0.split &&
      plate1.split &&
      configuredCryosectionIndexes.length === 2 &&
      plate0.segments[0].cryoIndex === plate1.segments[0].cryoIndex &&
      plate0.segments[1].cryoIndex === plate1.segments[1].cryoIndex
    ) {
      return 'Split-plate two cryosections';
    }
    return 'Flexible multi-cryosection';
  }, [configuredCryosectionIndexes, getPlateAssignment, plateCount]);
  const isSinglePlateProject = plateCount === 1;
  const getCryosectionName = useCallback(
    (cryoIndex: number | null | undefined) => {
      if (
        cryoIndex === null ||
        cryoIndex === undefined ||
        cryoIndex < 0 ||
        cryoIndex >= cryosections.length
      ) {
        return '';
      }
      return cryosections[cryoIndex]?.name ?? '';
    },
    [cryosections]
  );
  const getCryosectionColor = useCallback(
    (cryoIndex: number | null | undefined) => {
      if (
        cryoIndex === null ||
        cryoIndex === undefined ||
        cryoIndex < 0 ||
        cryoIndex >= cryosections.length
      ) {
        return 'rgba(148, 163, 184, 0.42)';
      }
      return cryosections[cryoIndex]?.color || getDefaultCryosectionColor(cryoIndex);
    },
    [cryosections]
  );
  const getPlateSegmentLabel = useCallback(
    (plateIndex: number, segmentIndex: 0 | 1) =>
      getCryosectionName(getPlateAssignment(plateIndex).segments[segmentIndex]?.cryoIndex),
    [getCryosectionName, getPlateAssignment]
  );
  const getCryoCsvTargets = useCallback(
    (
      cryoIndex: number,
      options?: {
        plateCount?: number;
        assignments?: PlateAssignment[];
        csvFilesByCryo?: string[][];
        csvSourceGroupIdsByCryo?: Array<string | null>;
      }
    ) => {
      const nextPlateCount = options?.plateCount ?? plateCount;
      const nextAssignments = options?.assignments ?? plateAssignments;
      const nextCsvFilesByCryo = options?.csvFilesByCryo ?? csvFilesByCryo;
      const nextCsvSourceGroupIdsByCryo =
        options?.csvSourceGroupIdsByCryo ?? csvSourceGroupIdsByCryo;
      return buildCryoCsvTargets(
        cryoIndex,
        nextPlateCount,
        nextAssignments,
        nextCsvFilesByCryo,
        nextCsvSourceGroupIdsByCryo
      );
    },
    [csvFilesByCryo, csvSourceGroupIdsByCryo, plateAssignments, plateCount]
  );
  const getCryoSourceSlotForPlateCell = useCallback(
    (cryoIndex: number, plateIndex: number, rowIndex: number, colIndex: number) => {
      const { targets } = getCryoCsvTargets(cryoIndex);
      const target = targets.find(
        (item) =>
          item.plateIndex === plateIndex &&
          colIndex >= item.startCol &&
          colIndex <= item.endCol
      );
      if (!target) {
        return undefined;
      }
      const sourceCol = target.sourceStartCol + (colIndex - target.startCol);
      if (!Number.isFinite(sourceCol) || sourceCol < 0 || sourceCol >= PLATE_COLS.length) {
        return undefined;
      }
      return {
        sourceCol,
        slot: sourceCol * PLATE_ROWS.length + rowIndex
      };
    },
    [getCryoCsvTargets]
  );
  const effectivePositiveStarts = useMemo(() => {
    const nextByCryo = Array.from({ length: MAX_CRYOSECTIONS }, () => DEFAULT_MICROSAMPLE_START);
    return Array.from({ length: MAX_PLATES }, (_, plateIndex) => {
      const assignment = getPlateAssignment(plateIndex);
      const plate = designPlates[plateIndex];
      const starts = [DEFAULT_MICROSAMPLE_START, DEFAULT_MICROSAMPLE_START] as [number, number];
      const segmentIndexes: Array<0 | 1> = assignment.split ? [0, 1] : [0];
      for (const segmentIndex of segmentIndexes) {
        const segment = assignment.segments[segmentIndex];
        const cryoIndex = segment?.cryoIndex;
        const current =
          cryoIndex !== null &&
          cryoIndex !== undefined &&
          cryoIndex >= 0 &&
          cryoIndex < cryosectionCount
            ? segment?.positiveManual
              ? segment.positiveStart || DEFAULT_MICROSAMPLE_START
              : nextByCryo[cryoIndex]
            : segment?.positiveStart || DEFAULT_MICROSAMPLE_START;
        starts[segmentIndex] = current;
        if (
          cryoIndex === null ||
          cryoIndex === undefined ||
          cryoIndex < 0 ||
          cryoIndex >= cryosectionCount ||
          !plate
        ) {
          continue;
        }
        const startCol = assignment.split && segmentIndex === 1 ? 6 : 0;
        const endCol = assignment.split && segmentIndex === 0 ? 5 : 11;
        let positiveCount = 0;
        for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
          for (let colIndex = startCol; colIndex <= endCol; colIndex += 1) {
            if ((plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE) === 'P') {
              positiveCount += 1;
            }
          }
        }
        nextByCryo[cryoIndex] = current + positiveCount;
      }
      if (!assignment.split) {
        starts[1] = starts[0];
      }
      return starts;
    });
  }, [cryosectionCount, designPlates, getPlateAssignment]);
  const effectiveNegativeStarts = useMemo(() => {
    const nextByCryo = Array.from({ length: MAX_CRYOSECTIONS }, () => DEFAULT_MICROSAMPLE_START);
    return Array.from({ length: MAX_PLATES }, (_, plateIndex) => {
      const assignment = getPlateAssignment(plateIndex);
      const plate = designPlates[plateIndex];
      const starts = [DEFAULT_MICROSAMPLE_START, DEFAULT_MICROSAMPLE_START] as [number, number];
      const segmentIndexes: Array<0 | 1> = assignment.split ? [0, 1] : [0];
      for (const segmentIndex of segmentIndexes) {
        const segment = assignment.segments[segmentIndex];
        const cryoIndex = segment?.cryoIndex;
        const current =
          cryoIndex !== null &&
          cryoIndex !== undefined &&
          cryoIndex >= 0 &&
          cryoIndex < cryosectionCount
            ? segment?.negativeManual
              ? segment.negativeStart || DEFAULT_MICROSAMPLE_START
              : nextByCryo[cryoIndex]
            : segment?.negativeStart || DEFAULT_MICROSAMPLE_START;
        starts[segmentIndex] = current;
        if (
          cryoIndex === null ||
          cryoIndex === undefined ||
          cryoIndex < 0 ||
          cryoIndex >= cryosectionCount ||
          !plate
        ) {
          continue;
        }
        const startCol = assignment.split && segmentIndex === 1 ? 6 : 0;
        const endCol = assignment.split && segmentIndex === 0 ? 5 : 11;
        let membraneCount = 0;
        let lysisCount = 0;
        let reactionCount = 0;
        for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
          for (let colIndex = startCol; colIndex <= endCol; colIndex += 1) {
            const sample = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
            if (sample === 'M') {
              membraneCount += 1;
            } else if (sample === 'Z') {
              lysisCount += 1;
            } else if (sample === 'R') {
              reactionCount += 1;
            }
          }
        }
        nextByCryo[cryoIndex] = current + Math.max(membraneCount, lysisCount, reactionCount);
      }
      if (!assignment.split) {
        starts[1] = starts[0];
      }
      return starts;
    });
  }, [cryosectionCount, designPlates, getPlateAssignment]);
  const emptySelectionSet = useMemo(() => new Set<string>(), []);

  const lifFiles = lifFilesByCryo[activeCryosection] ?? EMPTY_STRING_ARRAY;
  const csvFiles = csvFilesByCryo[activeCryosection] ?? EMPTY_STRING_ARRAY;
  const elements = elementsByCryo[activeCryosection] ?? EMPTY_UI_ELEMENTS;
  const selectedId = selectedIdByCryo[activeCryosection] ?? null;
  const selectedIds = selectedIdsByCryo[activeCryosection] ?? emptySelectionSet;
  const selectedCutIds = selectedCutIdsByCryo[activeCryosection] ?? emptySelectionSet;
  const cutPointVisibility =
    cutPointVisibilityByCryo[activeCryosection] ?? EMPTY_CUT_POINT_VISIBILITY;
  const orphanImageVisibility =
    orphanImageVisibilityByCryo[activeCryosection] ?? EMPTY_ORPHAN_IMAGE_VISIBILITY;
  const overview = overviewByCryo[activeCryosection] ?? createOverviewState();
  const stagePosition = cryosections[activeCryosection]?.stagePosition ?? DEFAULT_STAGE_POSITION;
  const getOverviewLayerRect = useCallback(
    (layer: OverviewLayerState) => {
      if (!stagePosition) {
        return null;
      }
      const stageSpec = STAGE_POSITIONS[stagePosition - 1];
      if (!stageSpec) {
        return null;
      }
      const baseX = stageSpec.slide.tl.x;
      const baseY = stageSpec.slide.tl.y;
      const baseW = stageSpec.slide.br.x - stageSpec.slide.tl.x;
      const baseH = stageSpec.slide.br.y - stageSpec.slide.tl.y;
      return {
        baseX,
        baseY,
        baseW,
        baseH,
        x: baseX + layer.offsetX,
        y: baseY + layer.offsetY,
        w: baseW * layer.scaleX,
        h: baseH * layer.scaleY
      };
    },
    [stagePosition]
  );
  const activeOverviewLayer = overview.activeLayer === 'pre' ? overview.pre : overview.post;
  const [overviewAlignmentDrafts, setOverviewAlignmentDrafts] = useState<{
    scaleX: string;
    scaleY: string;
    offsetX: string;
    offsetY: string;
  }>(() => ({
    scaleX: formatOverviewAlignmentValue('scaleX', activeOverviewLayer.scaleX),
    scaleY: formatOverviewAlignmentValue('scaleY', activeOverviewLayer.scaleY),
    offsetX: formatOverviewAlignmentValue('offsetX', activeOverviewLayer.offsetX),
    offsetY: formatOverviewAlignmentValue('offsetY', activeOverviewLayer.offsetY)
  }));
  const [editingOverviewAlignmentField, setEditingOverviewAlignmentField] =
    useState<OverviewAlignmentField | null>(null);
  const overviewSelection =
    overviewSelectionByCryo[activeCryosection] ?? createOverviewSelection();
  const overviewCrop = overviewCropByCryo[activeCryosection] ?? {
    rectPx: null,
    cuts: [],
    layer: 'pre'
  };
  const overviewContours =
    overviewContoursByCryo[activeCryosection] ?? EMPTY_OVERVIEW_CONTOURS;
  const activeOverviewContourId = activeOverviewContourByCryo[activeCryosection] ?? null;
  const activeOverviewContourAnchor =
    activeOverviewContourAnchorByCryo[activeCryosection] ?? null;
  const hoveredOverviewContourAnchor =
    hoveredOverviewContourAnchorByCryo[activeCryosection] ?? null;
  const overviewContourInsertPreview =
    overviewContourInsertPreviewByCryo[activeCryosection] ?? null;
  const overviewContourPreview = overviewContourPreviewByCryo[activeCryosection] ?? null;
  const overviewExport = overviewExportByCryo[activeCryosection] ?? null;

  useEffect(() => {
    if (
      overviewAlignmentImportSource !== null &&
      overviewAlignmentImportOptions.includes(overviewAlignmentImportSource)
    ) {
      return;
    }
    setOverviewAlignmentImportSource(overviewAlignmentImportOptions[0] ?? null);
  }, [overviewAlignmentImportOptions, overviewAlignmentImportSource]);

  useEffect(() => {
    if (
      activeOverviewContourAnchor &&
      (!activeOverviewContourId ||
        activeOverviewContourAnchor.contourId !== activeOverviewContourId ||
        !overviewContours.some(
          (contour) =>
            contour.id === activeOverviewContourAnchor.contourId &&
            activeOverviewContourAnchor.pointIndex >= 0 &&
            activeOverviewContourAnchor.pointIndex < contour.points.length
        ))
    ) {
      setActiveOverviewContourAnchorByCryo((prev) => replaceAt(prev, activeCryosection, null));
    }
  }, [
    activeCryosection,
    activeOverviewContourAnchor,
    activeOverviewContourId,
    overviewContours
  ]);

  useEffect(() => {
    setOverviewAlignmentDrafts((prev) => ({
      scaleX:
        editingOverviewAlignmentField === 'scaleX'
          ? prev.scaleX
          : formatOverviewAlignmentValue('scaleX', activeOverviewLayer.scaleX),
      scaleY:
        editingOverviewAlignmentField === 'scaleY'
          ? prev.scaleY
          : formatOverviewAlignmentValue('scaleY', activeOverviewLayer.scaleY),
      offsetX:
        editingOverviewAlignmentField === 'offsetX'
          ? prev.offsetX
          : formatOverviewAlignmentValue('offsetX', activeOverviewLayer.offsetX),
      offsetY:
        editingOverviewAlignmentField === 'offsetY'
          ? prev.offsetY
          : formatOverviewAlignmentValue('offsetY', activeOverviewLayer.offsetY)
    }));
  }, [
    activeOverviewLayer.offsetX,
    activeOverviewLayer.offsetY,
    activeOverviewLayer.scaleX,
    activeOverviewLayer.scaleY,
    activeCryosection,
    overview.activeLayer,
    editingOverviewAlignmentField
  ]);

  const importOverviewAlignmentFromCryosection = () => {
    if (
      overviewAlignmentImportSource === null ||
      overviewAlignmentImportSource < 0 ||
      overviewAlignmentImportSource >= overviewByCryo.length
    ) {
      return;
    }
    const sourceOverview = overviewByCryo[overviewAlignmentImportSource] ?? createOverviewState();
    setOverviewState((state) => ({
      ...state,
      pre: {
        ...state.pre,
        offsetX: sourceOverview.pre.offsetX,
        offsetY: sourceOverview.pre.offsetY,
        scaleX: sourceOverview.pre.scaleX,
        scaleY: sourceOverview.pre.scaleY
      },
      post: {
        ...state.post,
        offsetX: sourceOverview.post.offsetX,
        offsetY: sourceOverview.post.offsetY,
        scaleX: sourceOverview.post.scaleX,
        scaleY: sourceOverview.post.scaleY
      }
    }));
    setStatus(
      `Imported overview alignment from ${
        getCryosectionName(overviewAlignmentImportSource) ||
        `Cryosection ${overviewAlignmentImportSource + 1}`
      }.`
    );
  };

  const getDefaultExportSize = useCallback(() => {
    const width = 1000;
    let ratio = overviewSelection.aspect > 0 ? overviewSelection.aspect : 1;
    if (ratio <= 0 || !Number.isFinite(ratio)) {
      ratio = 1;
    }
    const height = Math.max(1, Math.round(width * ratio));
    return { w: width, h: height };
  }, [overviewSelection.aspect]);

  const overviewSelectionSizePx = (() => {
    if (!overviewSelection.rect) {
      return null;
    }
    const layerRect = getOverviewLayerRect(activeOverviewLayer);
    if (!layerRect || !activeOverviewLayer.bitmap) {
      return null;
    }
    const rect = normalizeRect(overviewSelection.rect);
    const imgW = activeOverviewLayer.bitmap.width;
    const imgH = activeOverviewLayer.bitmap.height;
    return {
      w: (rect.w / layerRect.w) * imgW,
      h: (rect.h / layerRect.h) * imgH
    };
  })();

  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const overviewContainerRef = useRef<HTMLDivElement>(null);
  const metadataSearchRef = useRef<HTMLInputElement>(null);
  const metadataColumnsButtonRef = useRef<HTMLButtonElement>(null);
  const metadataColumnsPopupRef = useRef<HTMLDivElement>(null);
  const metadataFiltersButtonRef = useRef<HTMLButtonElement>(null);
  const metadataFiltersPopupRef = useRef<HTMLDivElement>(null);
  const coordinatesCryosectionMenuRef = useRef<HTMLDivElement>(null);
  const coordinatesReuseMenuRef = useRef<HTMLDivElement>(null);
  const overviewCryosectionMenuRef = useRef<HTMLDivElement>(null);
  const mapPointsRef = useRef<Array<{ id: string; x: number; y: number; w: number; h: number }>>(
    []
  );
  const mapOrphanImageRectsRef = useRef<
    Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      w: number;
      h: number;
      imageWidth?: number;
      imageHeight?: number;
    }>
  >([]);
  const mapHoverPositionRef = useRef<{ x: number; y: number } | null>(null);
  const overviewPointsRef = useRef<Array<{ id: string; x: number; y: number; w: number; h: number }>>(
    []
  );
  const overviewContourAnchorsRef = useRef<
    Array<{ contourId: string; pointIndex: number; x: number; y: number }>
  >([]);
  const mapViewRef = useRef({
    zoom: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    dragDistance: 0
  });
  const overviewViewRef = useRef({
    zoom: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
    startX: 0,
    startY: 0
  });
  const mapTransformRef = useRef({
    baseScale: 1,
    baseOffsetX: 0,
    baseOffsetY: 0,
    minX: 0,
    minY: 0
  });
  const overviewTransformRef = useRef({
    baseScale: 1,
    baseOffsetX: 0,
    baseOffsetY: 0,
    minX: 0,
    minY: 0
  });
  const updateMapRef = useRef<() => void>(() => undefined);
  const updateOverviewRef = useRef<() => void>(() => undefined);
  const mapBoundsRef = useRef<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
  } | null>(null);
  const overviewBoundsRef = useRef<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
  } | null>(null);
  const selectionRef = useRef({
    isSelecting: false,
    startX: 0,
    startY: 0,
    endX: 0,
    endY: 0,
    dragDistance: 0
  });
  const mapPointDragRef = useRef({
    active: false,
    moved: false,
    shift: false,
    anchorId: null as string | null,
    ids: [] as string[],
    originCoords: {} as Record<string, { x: number; y: number }>,
    startCanvasX: 0,
    startCanvasY: 0,
    startStageX: 0,
    startStageY: 0
  });
  const overviewDragRef = useRef({
    isDragging: false,
    layer: 'pre' as 'pre' | 'post',
    startStageX: 0,
    startStageY: 0,
    startOffsetX: 0,
    startOffsetY: 0
  });
  const overviewContourDragRef = useRef({
    active: false,
    contourId: null as string | null,
    pointIndex: -1
  });
  const overviewSelectionRef = useRef({
    isSelecting: false,
    mode: 'new' as 'new' | 'move' | 'resize',
    handle: 'move' as 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw',
    startStageX: 0,
    startStageY: 0,
    startRect: { x: 0, y: 0, w: 0, h: 0 }
  });
  const designSelectionRef = useRef({
    isSelecting: false,
    plateIndex: -1,
    startRow: -1,
    startCol: -1,
    dragged: false,
    suppressNextClear: false,
    additive: false,
    baseKeys: new Set<string>()
  });
  const thumbCacheRef = useRef<Map<string, ThumbState>>(new Map());
  const thumbInFlightRef = useRef<Map<string, number>>(new Map());
  const thumbQueueRef = useRef<
    Array<{ key: string; size: number; elementId: string; sourceFile: string }>
  >([]);
  const overviewHistoryRef = useRef<OverviewState[][]>(createCryoStateArray(() => []));
  const saveProjectHandlerRef = useRef<(mode?: 'save' | 'saveAs') => Promise<void>>(async () => undefined);
  const loadProjectHandlerRef = useRef<
    (usersOverride?: string[], filePathOverride?: string) => Promise<void>
  >(async () => undefined);
  const newProjectHandlerRef = useRef<(usersOverride?: string[]) => void>(() => undefined);
  const undoOverviewRef = useRef<() => Promise<void>>(async () => undefined);
  const undoManualPointCreationRef = useRef<() => void>(() => undefined);
  const manualPointUndoStackRef = useRef<ManualPointUndoEntry[]>([]);
  const queueThumbnailLoadsRef = useRef<(desired: Map<string, ThumbnailRequest>) => void>(() => undefined);
  const collectionAreaHintTimerRef = useRef<number | null>(null);
  const pendingLoadPathRef = useRef<string | null>(null);

  const mapElements = useMemo(() => {
    const q = search.trim().toLowerCase();
    return elements.filter((item) => {
      const group = classifyElementName(item.name);
      if (group === 'other') {
        return false;
      }
      if (!q) {
        return true;
      }
      return [item.name, item.id, item.sourceFile ?? ''].some((value) =>
        value.toLowerCase().includes(q)
      );
    });
  }, [elements, search]);

  const hasCoordinateInputs = lifFiles.length > 0 && csvFiles.length > 0;
  const updatePlate = (
    index: number,
    key: 'label' | 'notes',
    value: string
  ) => {
    if (designLocked) {
      return;
    }
    setDesignPlates((prev) =>
      prev.map((plate, plateIndex) =>
        plateIndex === index ? { ...plate, [key]: value } : plate
      )
    );
  };

  const updatePlateBatchId = (index: number, value: string) => {
    setPlateBatchIds((prev) => replaceAt(prev, index, value) as [string, string]);
  };

  const updateCryosectionName = (index: number, value: string) => {
    setCryosections((prev) =>
      replaceAt(prev, index, {
        ...(prev[index] ?? {
          name: '',
          color: getDefaultCryosectionColor(index),
          stagePosition: DEFAULT_STAGE_POSITION
        }),
        name: value
      })
    );
  };

  const updateCryosectionStagePosition = (index: number, value: number) => {
    setCryosections((prev) =>
      replaceAt(prev, index, {
        ...(prev[index] ?? {
          name: '',
          color: getDefaultCryosectionColor(index),
          stagePosition: DEFAULT_STAGE_POSITION
        }),
        stagePosition: value
      })
    );
  };

  const updateCryosectionColor = (index: number, value: string) => {
    setCryosections((prev) =>
      replaceAt(prev, index, {
        ...(prev[index] ?? {
          name: '',
          color: getDefaultCryosectionColor(index),
          stagePosition: DEFAULT_STAGE_POSITION
        }),
        color: normalizeCryosectionColor(value, index)
      })
    );
  };

  const updatePlateAssignment = (
    plateIndex: number,
    updater: (assignment: PlateAssignment) => PlateAssignment
  ) => {
    setPlateAssignments((prev) => {
      const next = clonePlateAssignments(prev);
      next[plateIndex] = updater(next[plateIndex]);
      return next;
    });
  };

  const updatePlateSegmentAssignment = (
    plateIndex: number,
    segmentIndex: 0 | 1,
    updater: (segment: PlateSegmentAssignment) => PlateSegmentAssignment
  ) => {
    updatePlateAssignment(plateIndex, (assignment) => {
      const next = {
        ...assignment,
        segments: assignment.segments.map((segment) => ({ ...segment })) as [
          PlateSegmentAssignment,
          PlateSegmentAssignment
        ]
      };
      next.segments[segmentIndex] = updater(next.segments[segmentIndex]);
      return next;
    });
  };

  const applyLegacyCollectionEncodingChoice = (encodingMode: CollectionEncodingMode) => {
    setCollectionMetadata((prev) => ({ ...prev, encodingMode }));
    setLegacyCollectionPrompt(null);
    setStatus(
      encodingMode === 'corrected'
        ? 'Corrected legacy collection Y values for this session.'
        : 'Kept legacy collection Y values for this session.'
    );
  };

  useEffect(() => {
    setDesignPlates((prev) =>
      prev.map((plate, plateIndex) => {
        const nextLabel = formatPlateDisplayLabel(plateIndex, plateBatchIds[plateIndex] ?? '');
        const assignment = getPlateAssignment(plateIndex);
        const nextLeft = getPlateSegmentLabel(plateIndex, 0);
        const nextRight = assignment.split ? getPlateSegmentLabel(plateIndex, 1) : nextLeft;
        if (
          plate.label === nextLabel &&
          plate.leftName === nextLeft &&
          plate.rightName === nextRight
        ) {
          return plate;
        }
        return { ...plate, label: nextLabel, leftName: nextLeft, rightName: nextRight };
      })
    );
  }, [plateBatchIds, getPlateAssignment, getPlateSegmentLabel]);

  useEffect(() => {
    setPlateAssignments((prev) => {
      let changed = false;
      const next = clonePlateAssignments(prev);
      for (let plateIndex = 0; plateIndex < MAX_PLATES; plateIndex += 1) {
        for (const segmentIndex of [0, 1] as const) {
          const segment = next[plateIndex].segments[segmentIndex];
          if (
            segment.cryoIndex !== null &&
            (segment.cryoIndex < 0 || segment.cryoIndex >= cryosectionCount)
          ) {
            next[plateIndex].segments[segmentIndex] = { ...segment, cryoIndex: null };
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [cryosectionCount]);

  useEffect(() => {
    if (activeCryosection < cryosectionCount) {
      return;
    }
    setActiveCryosection(Math.max(0, cryosectionCount - 1));
  }, [activeCryosection, cryosectionCount]);

  useEffect(() => {
    if (selectedProjectSegment && selectedProjectSegment.plateIndex >= plateCount) {
      setSelectedProjectSegment({ plateIndex: 0, segmentIndex: 0 });
      return;
    }
    if (
      selectedProjectSegment &&
      selectedProjectSegment.segmentIndex === 1 &&
      !isPlateSplit(selectedProjectSegment.plateIndex)
    ) {
      setSelectedProjectSegment({
        plateIndex: selectedProjectSegment.plateIndex,
        segmentIndex: 0
      });
    }
  }, [selectedProjectSegment, plateCount, isPlateSplit]);

  const handlePlateCellMouseDown = (
    event: React.MouseEvent<HTMLTableCellElement>,
    plateIndex: number,
    rowIndex: number,
    colIndex: number
  ) => {
    if (designLocked) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const startKey = `${plateIndex}:${rowIndex}:${colIndex}`;
    const additive = event.shiftKey;
    const baseKeys = additive ? new Set(selectedPlateCells) : new Set<string>();
    if (additive) {
      baseKeys.add(startKey);
      setSelectedPlateCells(new Set(baseKeys));
    } else {
      setSelectedPlateCells(new Set([startKey]));
    }
    designSelectionRef.current = {
      isSelecting: true,
      plateIndex,
      startRow: rowIndex,
      startCol: colIndex,
      dragged: false,
      suppressNextClear: false,
      additive,
      baseKeys
    };
  };

  const handlePlateCellMouseEnter = (plateIndex: number, rowIndex: number, colIndex: number) => {
    const selection = designSelectionRef.current;
    if (!selection.isSelecting || selection.plateIndex !== plateIndex) {
      return;
    }
    if (rowIndex !== selection.startRow || colIndex !== selection.startCol) {
      selection.dragged = true;
    }
    const minRow = Math.min(selection.startRow, rowIndex);
    const maxRow = Math.max(selection.startRow, rowIndex);
    const minCol = Math.min(selection.startCol, colIndex);
    const maxCol = Math.max(selection.startCol, colIndex);
    const rectKeys = new Set<string>();
    for (let r = minRow; r <= maxRow; r += 1) {
      for (let c = minCol; c <= maxCol; c += 1) {
        rectKeys.add(`${plateIndex}:${r}:${c}`);
      }
    }
    if (selection.additive) {
      const next = new Set(selection.baseKeys);
      rectKeys.forEach((key) => next.add(key));
      setSelectedPlateCells(next);
      return;
    }
    setSelectedPlateCells(rectKeys);
  };

  const endPlateSelectionDrag = () => {
    if (!designSelectionRef.current.isSelecting) {
      return;
    }
    if (designSelectionRef.current.dragged) {
      designSelectionRef.current.suppressNextClear = true;
    }
    designSelectionRef.current.isSelecting = false;
  };

  const clearPlateSelection = () => {
    if (designSelectionRef.current.suppressNextClear) {
      designSelectionRef.current.suppressNextClear = false;
      return;
    }
    designSelectionRef.current.isSelecting = false;
    setSelectedPlateCells(new Set());
    setPlate2CopyMenu(null);
  };

  const togglePlateCollapsed = (plateIndex: number) => {
    setCollapsedPlates((prev) => {
      const next = [...prev] as [boolean, boolean];
      next[plateIndex] = !next[plateIndex];
      return next;
    });
  };

  const buildCsvPlates = useCallback(
    (
      rows: RawCsvRow[],
      targets: Array<{
        plateIndex: number;
        startCol: number;
        endCol: number;
        sourceStartCol: number;
        sourceEndCol: number;
      }>
    ) => {
      const resultPlates = Array.from({ length: visiblePlateCount }, () => createCsvCells());
      const sourceColumns = Array.from({ length: PLATE_COLS.length }, () => createCsvCells()[0]);
      let nextColumn = 0;
      let currentColumn = -1;
      let expectedRowIndex = 0;
      let currentAreaValue: number | undefined;
      let ignoredRowCount = 0;
      let ignoredNonEllipseCount = 0;
      let ignoredZeroAreaCount = 0;

      for (let sourceOrder = 0; sourceOrder < rows.length; sourceOrder += 1) {
        const row = rows[sourceOrder];
        if (isIgnoredCsvRow(row)) {
          ignoredRowCount += 1;
          const normalizedType = row.type.trim().toLowerCase();
          if (normalizedType && normalizedType !== 'ellipse') {
            ignoredNonEllipseCount += 1;
          }
          if (
            PLATE_ROWS.some((letter) => {
              const areaValue = parseAreaValue(row.areaByLetter[letter]);
              return areaValue !== undefined && areaValue <= 0;
            })
          ) {
            ignoredZeroAreaCount += 1;
          }
          continue;
        }
        const detectedLetter = detectRowLetter(row);
        let rowIndex =
          detectedLetter !== undefined ? PLATE_ROWS.indexOf(detectedLetter) : expectedRowIndex;
        if (rowIndex < 0) {
          rowIndex = expectedRowIndex;
        }
        const letter = detectedLetter ?? PLATE_ROWS[rowIndex];
        const areaValue = parseAreaValue(row.areaByLetter[letter]);

        if (currentColumn < 0) {
          currentColumn = nextColumn;
          nextColumn += 1;
          currentAreaValue = undefined;
        }

        if (areaValue !== undefined) {
          if (currentAreaValue === undefined) {
            currentAreaValue = areaValue;
          } else if (areaValue !== currentAreaValue) {
            currentColumn = nextColumn;
            nextColumn += 1;
            currentAreaValue = areaValue;
          }
        }
        if (currentColumn < 0 || currentColumn >= sourceColumns.length) {
          expectedRowIndex = (rowIndex + 1) % PLATE_ROWS.length;
          continue;
        }

        const imageNames = row.imageNames.trim();
        const { preImage, cutImage } = parseImageNames(imageNames);
        const coords = parseCoords(row.coords);

        const present =
          areaValue !== undefined ||
          imageNames.length > 0 ||
          preImage !== undefined ||
          cutImage !== undefined ||
          coords.x !== undefined ||
          coords.y !== undefined;

        const nextCell: CsvCell = {
          size: areaValue,
          images: imageNames,
          preImage,
          cutImage,
          pixelX: coords.x,
          pixelY: coords.y,
          sourceOrder,
          present
        };
        sourceColumns[currentColumn][rowIndex] = nextCell;

        expectedRowIndex = (rowIndex + 1) % PLATE_ROWS.length;
        // Do not auto-advance on row count; only advance when area size changes.
      }

      for (const target of targets) {
        const sourceStartCol = Math.max(0, target.sourceStartCol);
        const sourceEndCol = Math.min(11, target.sourceEndCol);
        for (
          let sourceColIndex = sourceStartCol;
          sourceColIndex <= sourceEndCol;
          sourceColIndex += 1
        ) {
          const offset = sourceColIndex - target.sourceStartCol;
          const colIndex = target.startCol + offset;
          if (colIndex > target.endCol || target.plateIndex >= resultPlates.length) {
            break;
          }
          for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
            const sourceCell = sourceColumns[sourceColIndex]?.[rowIndex];
            resultPlates[target.plateIndex][rowIndex][colIndex] = sourceCell
              ? { ...sourceCell }
              : {};
          }
        }
      }

      const placements = flattenCsvPlacementsFromPlates(resultPlates);
      return {
        resultPlates,
        placements,
        sourceColumnCount: nextColumn,
        ignoredRowCount,
        ignoredNonEllipseCount,
        ignoredZeroAreaCount
      };
    },
    [visiblePlateCount]
  );

  const elementByCryo = useMemo(() => {
    return elementsByCryo.map((list) => {
      const map = new Map<string, UiElement>();
      for (const item of list) {
        const key = item.name.trim();
        if (!map.has(key)) {
          map.set(key, item);
        }
      }
      return map;
    });
  }, [elementsByCryo]);

  const elementIndexByName = useMemo(() => {
    return elementsByCryo.map((list) => {
      const map = new Map<string, UiElement[]>();
      for (const item of list) {
        const key = normalizeImageName(item.name);
        if (!key) {
          continue;
        }
        const existing = map.get(key);
        if (existing) {
          existing.push(item);
        } else {
          map.set(key, [item]);
        }
      }
      return map;
    });
  }, [elementsByCryo]);

  const resolveElementByName = useCallback(
    (cryoIndex: number, rawName?: string) => {
      const name = rawName?.trim();
      if (!name) {
        return undefined;
      }
      const normalized = normalizeImageName(name);
      return (
        elementByCryo[cryoIndex]?.get(name) ??
        (normalized ? elementIndexByName[cryoIndex]?.get(normalized)?.[0] : undefined)
      );
    },
    [elementByCryo, elementIndexByName]
  );

  const resolveElementForImages = useCallback(
    (cryoIndex: number, preImage?: string, cutImage?: string) => {
      for (const rawName of [preImage, cutImage]) {
        const name = rawName?.trim();
        if (!name) {
          continue;
        }
        const element = resolveElementByName(cryoIndex, name);
        if (element) {
          return { imageName: name, element };
        }
      }
      return { imageName: undefined, element: undefined };
    },
    [resolveElementByName]
  );

  const buildImageCandidatesForCryo = useCallback(
    (cryoIndex: number) => {
      const list = elementsByCryo[cryoIndex] ?? [];
      const usedPostIndexes = new Set<number>();
      const candidates: ImageInferenceCandidate[] = [];
      for (const { item, index } of list
        .map((entry, entryIndex) => ({ item: entry, index: entryIndex }))
        .filter(({ item }) => classifyElementName(item.name) === 'pre')) {
          const preSeq = extractImageSequence(item.name);
          let post: UiElement | undefined;
          let postIndex = -1;
          let bestScore = Number.POSITIVE_INFINITY;
          for (let lookahead = index + 1; lookahead < Math.min(list.length, index + 12); lookahead += 1) {
            if (usedPostIndexes.has(lookahead)) {
              continue;
            }
            const candidate = list[lookahead];
            if (classifyElementName(candidate.name) !== 'post') {
              continue;
            }
            if (candidate.sourceFile !== item.sourceFile) {
              continue;
            }
            const preCollector = item.collectorHolderPosition?.trim().toUpperCase();
            const postCollector = candidate.collectorHolderPosition?.trim().toUpperCase();
            if (preCollector && postCollector && preCollector !== postCollector) {
              continue;
            }
            const postSeq = extractImageSequence(candidate.name);
            const diff =
              preSeq !== undefined && postSeq !== undefined ? postSeq - preSeq : undefined;
            if (diff !== undefined && (diff < 1 || diff > 6)) {
              continue;
            }
            const score =
              (preCollector && postCollector && preCollector === postCollector ? 0 : 10) +
              (diff ?? 5) +
              (lookahead - index) * 0.01;
            if (score < bestScore) {
              bestScore = score;
              post = candidate;
              postIndex = lookahead;
            }
          }
          if (postIndex >= 0) {
            usedPostIndexes.add(postIndex);
          }
          candidates.push({
            pre: item,
            post,
            order: index,
            collectorHolderPosition:
              item.collectorHolderPosition?.trim().toUpperCase() ??
              post?.collectorHolderPosition?.trim().toUpperCase()
          });
      }
      for (let index = 0; index < list.length; index += 1) {
        if (usedPostIndexes.has(index)) {
          continue;
        }
        const item = list[index];
        if (classifyElementName(item.name) !== 'post') {
          continue;
        }
        candidates.push({
          post: item,
          order: index,
          collectorHolderPosition: item.collectorHolderPosition?.trim().toUpperCase()
        });
      }
      candidates.sort((a, b) => a.order - b.order);
      return candidates;
    },
    [elementsByCryo]
  );

  const mergeCsvPlatesData = useCallback(
    (sourceCsvPlatesByCryo: CsvCell[][][][]) => {
      const platesCount = visiblePlateCount;
      const result: MergedCsvCell[][][] = Array.from({ length: platesCount }, () => createCsvCells());
      for (let plateIndex = 0; plateIndex < platesCount; plateIndex += 1) {
        for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
          for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
            const cryoIndex = getCellCryoIndex(plateIndex, colIndex);
            if (cryoIndex === null || cryoIndex === undefined) {
              result[plateIndex][rowIndex][colIndex] = {};
              continue;
            }
            const primaryCell =
              sourceCsvPlatesByCryo[cryoIndex]?.[plateIndex]?.[rowIndex]?.[colIndex];
            if (primaryCell && primaryCell.present) {
              result[plateIndex][rowIndex][colIndex] = {
                ...primaryCell,
                cryoIndex
              };
            } else {
              result[plateIndex][rowIndex][colIndex] = {};
            }
          }
        }
      }
      return result;
    },
    [visiblePlateCount, getCellCryoIndex]
  );

  const mergedCsvPlates = useMemo(() => {
    return mergeCsvPlatesData(csvPlatesByCryo);
  }, [csvPlatesByCryo, mergeCsvPlatesData]);

  const csvIssues = useMemo(() => {
    const hasAnyCsv =
      csvFilesByCryo.some((files) => files.length > 0) ||
      mergedCsvPlates.some((plate) =>
        plate.some((row) => row.some((cell) => cell.present))
      );
    if (!hasAnyCsv) {
      return { controlHasSample: 0, missingSample: 0 };
    }
    return computeCsvIssues(mergedCsvPlates, designPlates.slice(0, visiblePlateCount));
  }, [mergedCsvPlates, designPlates, visiblePlateCount, csvFilesByCryo]);

  const csvValidationMessage = useMemo(() => {
    const parts: string[] = [];
    if (csvIssues.controlHasSample > 0) {
      parts.push(`${csvIssues.controlHasSample} control wells have samples`);
    }
    if (csvIssues.missingSample > 0) {
      parts.push(`${csvIssues.missingSample} non-control wells missing samples`);
    }
    return parts.length ? `Validation: ${parts.join(' · ')}` : '';
  }, [csvIssues]);

  const codeMap = useMemo(() => {
    const map = new Map<string, string>();
    const createCounters = (
      assignment: PlateSegmentAssignment,
      positiveStart: number,
      negativeStart: number
    ) =>
      ({
        P: positiveStart - 1,
        M: negativeStart - 1,
        Z: negativeStart - 1,
        R: negativeStart - 1,
        N: 0
      } as Record<SampleType, number>);
    const counters = Array.from({ length: visiblePlateCount }, (_, plateIndex) => {
      const assignment = getPlateAssignment(plateIndex);
      return assignment.segments.map((segment, segmentIndex) =>
        createCounters(
          segment,
          effectivePositiveStarts[plateIndex]?.[segmentIndex] ?? DEFAULT_MICROSAMPLE_START,
          effectiveNegativeStarts[plateIndex]?.[segmentIndex] ?? DEFAULT_MICROSAMPLE_START
        )
      ) as [
        Record<SampleType, number>,
        Record<SampleType, number>
      ];
    });

    designPlates.slice(0, visiblePlateCount).forEach((plate, plateIndex) => {
      for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
        const segmentIndex = getSegmentIndexForColumn(plateIndex, colIndex);
        const assignment = getPlateAssignment(plateIndex).segments[segmentIndex];
        const label = getCryosectionName(assignment.cryoIndex);

        for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
          const sample = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
          if (sample === DISABLED_SAMPLE) {
            map.set(`${plateIndex}-${rowIndex}-${colIndex}`, '');
            continue;
          }
          if (assignment.cryoIndex === null || !label.trim()) {
            map.set(`${plateIndex}-${rowIndex}-${colIndex}`, '');
            continue;
          }
          counters[plateIndex][segmentIndex][sample] += 1;

          let prefix = label;
          if (sample === 'M' || sample === 'Z' || sample === 'R') {
            prefix = withControlSuffix(prefix, sample);
          }

          const code = `${prefix}${String(counters[plateIndex][segmentIndex][sample]).padStart(3, '0')}`;
          map.set(`${plateIndex}-${rowIndex}-${colIndex}`, code);
        }
      }
    });

    return map;
  }, [
    designPlates,
    visiblePlateCount,
    getPlateAssignment,
    getSegmentIndexForColumn,
    getCryosectionName,
    effectivePositiveStarts,
    effectiveNegativeStarts
  ]);

  const cutPoints = useMemo(() => {
    if (!coordinatesReady) {
      return [];
    }
    const plates = csvPlatesByCryo[activeCryosection] ?? [];
    const elementMap = elementByCryo[activeCryosection];
    const elementIndex = elementIndexByName[activeCryosection];
    const coordinateOverrides = coordinateOverridesByCryo[activeCryosection] ?? {};
    if (!elementMap) {
      return [];
    }
    const result: Array<{
      id: string;
      x: number;
      y: number;
      sample: SampleType;
      code?: string;
      preImage?: string;
      cutImage?: string;
      inferred: boolean;
      inferenceConfirmed: boolean;
      plateLabel: string;
      well: string;
      elementUiId?: string;
      imageUiIds: string[];
      plateIndex: number;
      rowIndex: number;
      colIndex: number;
    }> = [];
    for (let plateIndex = 0; plateIndex < visiblePlateCount; plateIndex += 1) {
      for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
        for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
          const cell = plates[plateIndex]?.[rowIndex]?.[colIndex];
          if (!cell || !cell.present) {
            continue;
          }
          const imageNamesRaw = joinImageNames(cell.preImage, cell.cutImage) || cell.images?.trim() || '';
          const imageNames = imageNamesRaw
            .split(/[,;]+/)
            .map((value) => value.trim())
            .filter(Boolean);
          const singleLinkedImage = isSingleLinkedImageCsvCell(cell);
          const referenceImage = singleLinkedImage
            ? undefined
            : cell.preImage?.trim() || cell.cutImage?.trim();
          const isManualCoordinateOnly =
            cell.manualAssigned === true &&
            !referenceImage &&
            isManualCoordinateLabel(cell.images);
          const allowCachedCoordinates = !singleLinkedImage || isManualCoordinateOnly;
          if (!referenceImage && !isManualCoordinateOnly) {
            continue;
          }
          if (!isManualCoordinateOnly && (imageNames.length === 0 || cell.pixelX === undefined || cell.pixelY === undefined)) {
            continue;
          }
          const cacheKey = `${plateIndex}-${rowIndex}-${colIndex}`;
          const cached = coordinateCache[cacheKey];
          const hasOverride = coordinateOverrides[cacheKey] === true;
          const { element } = resolveElementForImages(
            activeCryosection,
            cell.preImage,
            cell.cutImage
          );
          let computedX: number | undefined;
          let computedY: number | undefined;
          if (
            element &&
            element.stageX !== undefined &&
            element.stageY !== undefined &&
            element.width !== undefined &&
            element.height !== undefined
          ) {
            const originX = element.stageX - (element.width * micronsPerPixel) / 2;
            const originY = element.stageY - (element.height * micronsPerPixel) / 2;
            computedX = originX + cell.pixelX * micronsPerPixel;
            computedY = originY + cell.pixelY * micronsPerPixel;
          }
          let x: number | undefined;
          let y: number | undefined;
          if (allowCachedCoordinates && hasOverride && cached) {
            x = cached.x;
            y = cached.y;
          } else if (Number.isFinite(computedX) && Number.isFinite(computedY)) {
            x = computedX;
            y = computedY;
          } else if (allowCachedCoordinates && cached) {
            x = cached.x;
            y = cached.y;
          }
          if (Number.isFinite(x) && Number.isFinite(y)) {
            const sample = designPlates[plateIndex]?.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
            if (sample === DISABLED_SAMPLE) {
              continue;
            }
            const id = `${plateIndex}-${rowIndex}-${colIndex}`;
            const code = codeMap.get(id);
            const plateLabel = designPlates[plateIndex]?.label || `Plate ${plateIndex + 1}`;
            const well = `${PLATE_ROWS[rowIndex]}${PLATE_COLS[colIndex]}`;
            const imageUiIdSet = new Set<string>();
            for (const name of imageNames) {
              const normalized = normalizeImageName(name);
              const matches = normalized ? elementIndex?.get(normalized) ?? [] : [];
              if (matches.length) {
                for (const match of matches) {
                  imageUiIdSet.add(match.uiId);
                }
                continue;
              }
              const direct = elementMap.get(name);
              if (direct) {
                imageUiIdSet.add(direct.uiId);
              }
            }
            const imageUiIds = Array.from(imageUiIdSet);
            result.push({
              id,
              x: x as number,
              y: y as number,
              sample,
              code,
              preImage: cell.preImage?.trim() || undefined,
              cutImage: cell.cutImage?.trim() || undefined,
              inferred: cell.inferred === true,
              inferenceConfirmed: cell.inferenceConfirmed === true,
              plateLabel,
              well,
              elementUiId: element?.uiId,
              imageUiIds,
              plateIndex,
              rowIndex,
              colIndex
            });
          }
        }
      }
    }
    return result;
  }, [
    activeCryosection,
    coordinatesReady,
    csvPlatesByCryo,
    elementByCryo,
    elementIndexByName,
    micronsPerPixel,
    resolveElementForImages,
    designPlates,
    codeMap,
    coordinateCache,
    coordinateOverridesByCryo,
    visiblePlateCount
  ]);

  const filteredCutPoints = useMemo(() => cutPoints, [cutPoints]);

  const cutPointDisplay = useMemo(() => {
    const visibility = cutPointVisibility;
    const visiblePoints = filteredCutPoints.filter(
      (point) => visibility[point.id]?.point ?? true
    );
    const visibleImageIds = new Set<string>();
    const allImageIds = new Set<string>();
    for (const point of filteredCutPoints) {
      for (const imageId of point.imageUiIds) {
        allImageIds.add(imageId);
        if (visibility[point.id]?.image ?? true) {
          visibleImageIds.add(imageId);
        }
      }
    }
    return { visiblePoints, visibleImageIds, allImageIds };
  }, [filteredCutPoints, cutPointVisibility]);

  const visibleCoordinateCutPoints = useMemo(
    () => (coordinatesReady && showCutPoints ? cutPointDisplay.visiblePoints : []),
    [coordinatesReady, cutPointDisplay.visiblePoints, showCutPoints]
  );

  const overviewCutPoints = useMemo(() => {
    let points = cutPointDisplay.visiblePoints;
    if (selectedCutIds.size > 0) {
      points = points.filter((point) => selectedCutIds.has(point.id));
    }
    if (!overview.showMembraneControls) {
      points = points.filter((point) => point.sample !== 'M');
    }
    return points;
  }, [cutPointDisplay.visiblePoints, selectedCutIds, overview.showMembraneControls]);

  const overviewImageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const point of overviewCutPoints) {
      for (const imageId of point.imageUiIds) {
        ids.add(imageId);
      }
    }
    return ids;
  }, [overviewCutPoints]);

  const cutPointById = useMemo(() => {
    const map = new Map<string, (typeof cutPoints)[number]>();
    for (const point of cutPoints) {
      map.set(point.id, point);
    }
    return map;
  }, [cutPoints]);

  const assignedImageIdsByCryo = useMemo(() => {
    return ([0, 1] as const).map((cryoIndex) => {
      const ids = new Set<string>();
      const elementMap = elementByCryo[cryoIndex];
      const elementIndex = elementIndexByName[cryoIndex];
      const plates = csvPlatesByCryo[cryoIndex] ?? [];
      for (const plate of plates) {
        for (const row of plate) {
          for (const cell of row) {
            if (!cell?.present) {
              continue;
            }
            if (isSingleLinkedImageCsvCell(cell)) {
              continue;
            }
            for (const name of [cell.preImage, cell.cutImage]) {
              const normalized = normalizeImageName(name);
              if (!normalized) {
                continue;
              }
              const matches = elementIndex?.get(normalized) ?? [];
              if (matches.length) {
                for (const match of matches) {
                  ids.add(match.uiId);
                }
                continue;
              }
              const direct = name ? elementMap.get(name) : undefined;
              if (direct) {
                ids.add(direct.uiId);
              }
            }
          }
        }
      }
      return ids;
    }) as [Set<string>, Set<string>];
  }, [csvPlatesByCryo, elementByCryo, elementIndexByName]);

  const orphanImageIds = useMemo(() => {
    const assigned = assignedImageIdsByCryo[activeCryosection] ?? new Set<string>();
    const ids = new Set<string>();
    for (const item of mapElements) {
      if (item.stageX === undefined || item.stageY === undefined) {
        continue;
      }
      if (!assigned.has(item.uiId)) {
        ids.add(item.uiId);
      }
    }
    return ids;
  }, [activeCryosection, assignedImageIdsByCryo, mapElements]);

  const orphanImageInfoById = useMemo(() => {
    const names = new Map<string, { name: string; collector?: string }>();
    for (const item of mapElements) {
      if (orphanImageIds.has(item.uiId)) {
        names.set(item.uiId, {
          name: item.name,
          collector: item.collectorHolderPosition?.trim().toUpperCase() || undefined
        });
      }
    }
    return names;
  }, [mapElements, orphanImageIds]);

  const orphanImageRows = useMemo(() => {
    return mapElements
      .filter((item) => orphanImageIds.has(item.uiId))
      .filter((item) => {
        const group = classifyElementName(item.name);
        if (group === 'pre') {
          return showCoordinateOrphanPreImages;
        }
        if (group === 'post') {
          return showCoordinateOrphanPostImages;
        }
        return false;
      })
      .filter((item) => {
        if (coordinateOrphanCollectorFilter === 'all') {
          return true;
        }
        return item.collectorHolderPosition?.trim().toUpperCase() === coordinateOrphanCollectorFilter;
      })
      .map((item) => ({
        id: item.uiId,
        name: item.name,
        collector: item.collectorHolderPosition?.trim().toUpperCase() || '',
        visible: orphanImageVisibility[item.uiId] !== false,
        sequence: extractImageSequence(item.name) ?? Number.MAX_SAFE_INTEGER
      }))
      .sort((a, b) =>
        a.sequence !== b.sequence ? a.sequence - b.sequence : a.name.localeCompare(b.name)
      );
  }, [
    coordinateOrphanCollectorFilter,
    mapElements,
    orphanImageIds,
    orphanImageVisibility,
    showCoordinateOrphanPostImages,
    showCoordinateOrphanPreImages
  ]);
  const coordinateOrphansEnabled =
    showCoordinateOrphanPreImages || showCoordinateOrphanPostImages;

  const coordinateVisibleImagePoints = useMemo<CoordinateImagePoint[]>(() => {
    if (!hasCoordinateInputs) {
      return [];
    }
    const visibleImageIds = new Set(cutPointDisplay.visibleImageIds);
    const allImageIds = new Set(cutPointDisplay.allImageIds);
    if (coordinateOrphansEnabled) {
      for (const row of orphanImageRows) {
        if (!row.visible) {
          continue;
        }
        allImageIds.add(row.id);
        visibleImageIds.add(row.id);
      }
    }

    const filterByCutImages = allImageIds.size > 0;
    return mapElements
      .filter((item) => item.stageX !== undefined && item.stageY !== undefined)
      .filter((item) => {
        const isOrphan = orphanImageIds.has(item.uiId);
        if (isOrphan) {
          return visibleImageIds.has(item.uiId);
        }
        const group = classifyElementName(item.name);
        if (group === 'pre' && !filterPre) {
          return false;
        }
        if (group === 'post' && !filterPost) {
          return false;
        }
        if (!filterByCutImages) {
          return true;
        }
        return allImageIds.has(item.uiId) && visibleImageIds.has(item.uiId);
      })
      .map((item) => ({
        id: item.uiId,
        elementId: item.id,
        name: item.name,
        sourceFile: item.sourceFile,
        x: item.stageX as number,
        y: item.stageY as number,
        supported: item.supported,
        width: item.width,
        height: item.height,
        orphan: orphanImageIds.has(item.uiId),
        sequence: extractImageSequence(item.name) ?? Number.MIN_SAFE_INTEGER
      }))
      .sort((a, b) =>
        a.sequence !== b.sequence ? a.sequence - b.sequence : a.name.localeCompare(b.name)
      );
  }, [
    coordinateOrphansEnabled,
    cutPointDisplay.allImageIds,
    cutPointDisplay.visibleImageIds,
    filterPost,
    filterPre,
    hasCoordinateInputs,
    mapElements,
    orphanImageIds,
    orphanImageRows
  ]);

  const orphanAssignmentImagesById = useMemo(() => {
    const result = new Map<
      string,
      { orphanName: string; preImage?: string; cutImage?: string }
    >();
    const orphanSet = orphanImageIds;
    const candidates = buildImageCandidatesForCryo(activeCryosection);
    for (const candidate of candidates) {
      if (candidate.pre && orphanSet.has(candidate.pre.uiId)) {
        result.set(candidate.pre.uiId, {
          orphanName: candidate.pre.name,
          preImage: candidate.pre.name,
          cutImage:
            candidate.post && orphanSet.has(candidate.post.uiId)
              ? candidate.post.name
              : undefined
        });
      }
      if (candidate.post && orphanSet.has(candidate.post.uiId)) {
        result.set(candidate.post.uiId, {
          orphanName: candidate.post.name,
          preImage:
            candidate.pre && orphanSet.has(candidate.pre.uiId)
              ? candidate.pre.name
              : undefined,
          cutImage: candidate.post.name
        });
      }
    }
    for (const item of mapElements) {
      if (!orphanSet.has(item.uiId) || result.has(item.uiId)) {
        continue;
      }
      const group = classifyElementName(item.name);
      result.set(item.uiId, {
        orphanName: item.name,
        preImage: group === 'pre' ? item.name : undefined,
        cutImage: group === 'post' ? item.name : undefined
      });
    }
    return result;
  }, [activeCryosection, buildImageCandidatesForCryo, mapElements, orphanImageIds]);

  const cutPointRows = useMemo(() => {
    let rows = filteredCutPoints.slice();
    rows.sort((a, b) => {
      if (a.plateIndex !== b.plateIndex) {
        return a.plateIndex - b.plateIndex;
      }
      if (a.colIndex !== b.colIndex) {
        return a.colIndex - b.colIndex;
      }
      return a.rowIndex - b.rowIndex;
    });
    if (selectedCutIds.size > 0) {
      rows = rows.filter((row) => selectedCutIds.has(row.id));
    }
    const query = cutPointSearch.trim().toLowerCase();
    if (!query) {
      return rows;
    }
    return rows.filter((row) =>
      [row.plateLabel, row.well, row.code ?? '', row.preImage ?? '', row.cutImage ?? '']
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [filteredCutPoints, cutPointSearch, selectedCutIds]);

  const metadataRows = useMemo(() => {
    return designPlates.slice(0, visiblePlateCount).flatMap((plate, plateIndex) =>
      PLATE_COLS.flatMap((col, colIndex) =>
        PLATE_ROWS.map((row, rowIndex) => {
          const sample = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
          const isDisabledSample = sample === DISABLED_SAMPLE;
          const segmentIndex = getSegmentIndexForColumn(plateIndex, colIndex);
          const half = isPlateSplit(plateIndex)
            ? segmentIndex === 0
              ? 'left'
              : 'right'
            : 'left';
          const halfLabelBase = getPlateSegmentLabel(plateIndex, segmentIndex);
          const halfLabel = getCryosectionLabelForSample(halfLabelBase, sample);
          const collection = collectionPlates[plateIndex]?.[rowIndex]?.[colIndex] ?? {
            left: 0,
            right: 0,
            rightTouched: false
          };
          const collectionLabel =
            isDisabledSample || (collection.left === 0 && collection.right === 0)
              ? ''
              : `c${collection.left}y${getCollectionYValue(
                  collection.right,
                  collectionMetadata.encodingMode
                )}`;
          const csvCell = mergedCsvPlates[plateIndex]?.[rowIndex]?.[colIndex] ?? {};
          const cryoIndex = csvCell.cryoIndex ?? getCellCryoIndex(plateIndex, colIndex) ?? 0;
          const singleLinkedImage = isSingleLinkedImageCsvCell(csvCell);
          const manualAssigned =
            csvCell.manualAssigned === true ||
            (isManualCoordinateLabel(csvCell.images) &&
              !csvCell.preImage?.trim() &&
              !csvCell.cutImage?.trim());
          const cellHasData = csvCell.present || hasCsvCellData(csvCell);
          const images = isDisabledSample
            ? ''
            : cellHasData
              ? joinImageNames(csvCell.preImage, csvCell.cutImage) ||
                (manualAssigned ? MANUAL_COORDINATE_LABEL : csvCell.images || '')
              : '';
          const size = isDisabledSample ? undefined : cellHasData ? csvCell.size : undefined;
          const referenceImageName = singleLinkedImage
            ? undefined
            : csvCell.preImage?.trim() || csvCell.cutImage?.trim();
          const element =
            !isDisabledSample && coordinatesReady && csvCell.present && referenceImageName
              ? resolveElementForImages(cryoIndex, csvCell.preImage, csvCell.cutImage).element
              : undefined;
          const cacheKey = `${plateIndex}-${rowIndex}-${colIndex}`;
          const cached = coordinateCache[cacheKey];
          const coordOverrides = coordinateOverridesByCryo[cryoIndex] ?? {};
          const hasOverride = coordOverrides[cacheKey] === true;
          let computedX: number | undefined;
          let computedY: number | undefined;
          const allowCachedCoordinates = !singleLinkedImage || manualAssigned;
          if (
            !isDisabledSample &&
            coordinatesReady &&
            element &&
            element.stageX !== undefined &&
            element.stageY !== undefined &&
            element.width !== undefined &&
            element.height !== undefined &&
            csvCell.pixelX !== undefined &&
            csvCell.pixelY !== undefined
          ) {
            const originX = element.stageX - (element.width * micronsPerPixel) / 2;
            const originY = element.stageY - (element.height * micronsPerPixel) / 2;
            computedX = originX + csvCell.pixelX * micronsPerPixel;
            computedY = originY + csvCell.pixelY * micronsPerPixel;
          }
          let xCoord: number | undefined;
          let yCoord: number | undefined;
          if (isDisabledSample) {
            xCoord = undefined;
            yCoord = undefined;
          } else if (allowCachedCoordinates && hasOverride && cached) {
            xCoord = cached.x;
            yCoord = cached.y;
          } else if (Number.isFinite(computedX) && Number.isFinite(computedY)) {
            xCoord = computedX;
            yCoord = computedY;
          } else if (allowCachedCoordinates && cached) {
            xCoord = cached.x;
            yCoord = cached.y;
          }
          const coordPresent = xCoord !== undefined && yCoord !== undefined;
          const controlHasCollectionInfo =
            (sample === 'Z' || sample === 'R') && collectionLabel.length > 0;
          const inferred = csvCell.inferred === true;
          const inferenceConfirmed = csvCell.inferenceConfirmed === true;
          let coordStatus: 'ok' | 'bad' | 'pending' | 'warn' = 'pending';
          if (isDisabledSample) {
            coordStatus = 'pending';
          } else if (controlHasCollectionInfo) {
            coordStatus = 'warn';
          } else if (manualAssigned && coordPresent) {
            coordStatus = 'warn';
          } else if (inferred && coordPresent && !inferenceConfirmed) {
            coordStatus = 'warn';
          } else if (coordinatesReady) {
            if (sample === 'Z' || sample === 'R') {
              coordStatus = coordPresent ? 'bad' : 'ok';
            } else {
              coordStatus = coordPresent ? 'ok' : 'bad';
            }
          }
          const contourDistances: Record<string, number | undefined> = {};
          if (xCoord !== undefined && yCoord !== undefined) {
            const cryoContours = overviewContoursByCryo[cryoIndex] ?? [];
            for (const contour of cryoContours) {
              const distance = closestDistanceToPolyline(
                xCoord,
                yCoord,
                contour.points,
                contour.closed
              );
              if (distance !== undefined) {
                const contourKey = contourNameColumnKey(getContourDisplayName(contour.name));
                const currentDistance = contourDistances[contourKey];
                contourDistances[contourKey] =
                  currentDistance === undefined ? distance : Math.min(currentDistance, distance);
              }
            }
          }
          const code = codeMap.get(`${plateIndex}-${rowIndex}-${colIndex}`) ?? '';
          const number = code ? code.slice(-3) : '';
          return {
            key: `meta-${plateIndex}-${row}-${col}`,
            well: `${col}${row}`,
            plateLabel: plate.label || `Plate ${plateIndex + 1}`,
            batch: projectName,
            halfLabel,
            half,
            cryoIndex,
            sample,
            plateIndex,
            rowIndex,
            colIndex,
            coordStatus,
            inferred,
            inferenceConfirmed,
            manualAssigned,
            code,
            number,
            collection: collectionLabel,
            collectionMethod:
              collectionMetadata.collectionMethod || COLLECTION_METHOD_OPTIONS[0],
            shape: sample === 'P' || sample === 'M' ? 'Elipse' : '',
            images,
            pixelX: csvCell.pixelX,
            pixelY: csvCell.pixelY,
            xCoord,
            yCoord,
            size,
            notes: metadataNotes[`${plateIndex}-${rowIndex}-${colIndex}`] ?? '',
            contourDistances
          };
        })
      )
    );
  }, [
    designPlates,
    collectionPlates,
    mergedCsvPlates,
    codeMap,
    micronsPerPixel,
    coordinatesReady,
    coordinateCache,
    coordinateOverridesByCryo,
    metadataNotes,
    collectionMetadata.collectionMethod,
    collectionMetadata.encodingMode,
    projectName,
    resolveElementForImages,
    visiblePlateCount,
    isPlateSplit,
    getPlateSegmentLabel,
    getSegmentIndexForColumn,
    getCellCryoIndex,
    overviewContoursByCryo
  ]);

  const orphanAssignmentTargets = useMemo(() => {
    return metadataRows
      .filter(
        (row) =>
          row.cryoIndex === activeCryosection &&
          row.sample !== 'Z' &&
          row.sample !== 'R' &&
          row.sample !== 'N' &&
          (row.xCoord === undefined || row.yCoord === undefined)
      )
      .map((row) => ({
        plateIndex: row.plateIndex,
        rowIndex: row.rowIndex,
        colIndex: row.colIndex,
        plateLabel: row.plateLabel,
        well: row.well,
        code: row.code,
        sample: row.sample
      }));
  }, [activeCryosection, metadataRows]);

  const buildAssignmentImageOptionsForCryo = useCallback(
    (cryoIndex: number, imageNames: string[]) => {
      const seen = new Set<string>();
      const options: OrphanAssignmentImageOption[] = [];
      for (const rawName of imageNames) {
        const imageName = rawName?.trim();
        if (!imageName) {
          continue;
        }
        const key = orphanAssignmentImageKey(imageName);
        if (!key || seen.has(key)) {
          continue;
        }
        const element = resolveElementByName(cryoIndex, imageName);
        if (!element) {
          continue;
        }
        const group = classifyElementName(imageName);
        if (group !== 'pre' && group !== 'post') {
          continue;
        }
        seen.add(key);
        options.push({
          key,
          imageName,
          group,
          sequence: extractImageSequence(imageName) ?? Number.MAX_SAFE_INTEGER,
          elementId: element.id,
          sourceFile: element.sourceFile,
          stageX: element.stageX,
          stageY: element.stageY,
          width: element.width,
          height: element.height
        });
      }
      options.sort((a, b) =>
        a.sequence !== b.sequence ? a.sequence - b.sequence : a.imageName.localeCompare(b.imageName)
      );
      return options;
    },
    [resolveElementByName]
  );

  const buildCollectorOrphanImageOptions = useCallback(
    (cryoIndex: number, collector: string) => {
      const assigned = assignedImageIdsByCryo[cryoIndex] ?? new Set<string>();
      const upperCollector = collector.trim().toUpperCase();
      return (elementsByCryo[cryoIndex] ?? [])
        .filter((item) => item.stageX !== undefined && item.stageY !== undefined)
        .filter((item) => !assigned.has(item.uiId))
        .filter((item) => classifyElementName(item.name) === 'pre' || classifyElementName(item.name) === 'post')
        .filter(
          (item) => item.collectorHolderPosition?.trim().toUpperCase() === upperCollector
        )
        .map((item) => ({
          key: orphanAssignmentImageKey(item.name),
          imageName: item.name,
          group: classifyElementName(item.name) as 'pre' | 'post',
          sequence: extractImageSequence(item.name) ?? Number.MAX_SAFE_INTEGER,
          elementId: item.id,
          sourceFile: item.sourceFile,
          stageX: item.stageX,
          stageY: item.stageY,
          width: item.width,
          height: item.height
        }))
        .sort((a, b) =>
          a.sequence !== b.sequence ? a.sequence - b.sequence : a.imageName.localeCompare(b.imageName)
        );
    },
    [assignedImageIdsByCryo, elementsByCryo]
  );

  const openMetadataRowOrphanAssignment = useCallback(
    (row: (typeof metadataRows)[number]) => {
      const collector = PLATE_ROWS[row.rowIndex];
      const target: OrphanAssignmentTarget = {
        plateIndex: row.plateIndex,
        rowIndex: row.rowIndex,
        colIndex: row.colIndex,
        plateLabel: row.plateLabel,
        well: row.well,
        code: row.code,
        sample: row.sample
      };
      const selectedCell =
        csvPlatesByCryo[row.cryoIndex]?.[row.plateIndex]?.[row.rowIndex]?.[row.colIndex];
      const imageOptions = buildCollectorOrphanImageOptions(row.cryoIndex, collector);
      setActiveCryosection(row.cryoIndex);
      setActiveTab('viewer');
      setSelectedCutIdsByCryo((prev) => replaceAt(prev, row.cryoIndex, new Set()));
      setCutPointSearch('');
      setFilterPre(false);
      setFilterPost(false);
      setShowCoordinateOrphanPreImages(true);
      setShowCoordinateOrphanPostImages(true);
      setCoordinateOrphanCollectorFilter(collector);
      setCoordinatesSelectionCollapsed(true);
      setCoordinatesOrphansCollapsed(false);
      setCoordinatesFiltersCollapsed(false);
      setManualCoordinatePrompt(null);
      setOrphanAssignmentPrompt({
        mode: 'metadata-well',
        contextLabel: `Assign orphan images to ${row.plateLabel} · ${formatWellDisplay(row.well)}${row.code ? ` · ${row.code}` : ''}`,
        collector,
        pixelX: selectedCell?.pixelX ?? 0,
        pixelY: selectedCell?.pixelY ?? 0,
        initialTargetKey: orphanAssignmentTargetKey(target),
        targets: [target],
        imageOptions
      });
    },
    [buildCollectorOrphanImageOptions, csvPlatesByCryo]
  );

  const baseMetadataColumns = useMemo<MetadataDisplayColumn[]>(
    () => METADATA_COLUMNS.map((column) => ({ key: column.key, label: column.label })),
    []
  );
  const orderedBaseMetadataColumns = useMemo<MetadataDisplayColumn[]>(
    () => orderMetadataColumns(baseMetadataColumns, metadataColumnOrder),
    [baseMetadataColumns, metadataColumnOrder]
  );

  const contourMetadataColumns = useMemo<MetadataDisplayColumn[]>(() => {
    const columns = new Map<string, MetadataDisplayColumn>();
    for (let cryoIndex = 0; cryoIndex < cryosectionCount; cryoIndex += 1) {
      for (const contour of overviewContoursByCryo[cryoIndex] ?? []) {
        const displayName = getContourDisplayName(contour.name);
        const key = contourNameColumnKey(displayName);
        if (!columns.has(key)) {
          columns.set(key, {
            key,
            label: `${displayName} (µm)`,
            isContour: true
          });
        }
      }
    }
    return Array.from(columns.values());
  }, [cryosectionCount, overviewContoursByCryo]);

  const allMetadataColumns = useMemo<MetadataDisplayColumn[]>(
    () => [...orderedBaseMetadataColumns, ...contourMetadataColumns],
    [orderedBaseMetadataColumns, contourMetadataColumns]
  );

  const getMetadataColumnValue = useCallback(
    (
      row: (typeof metadataRows)[number],
      column: string,
      mode: 'search' | 'export' = 'search'
    ) => {
      if (isContourNameColumnKey(column)) {
        const value = row.contourDistances?.[column];
        if (value === undefined) {
          return '';
        }
        return mode === 'export' ? formatNumber(value, 2) : value.toString();
      }
      switch (column as MetadataColumnKey) {
        case 'status':
          if (mode === 'export') {
            if (row.manualAssigned) {
              return 'MANUAL';
            }
            if (row.inferred && !row.inferenceConfirmed) {
              return 'INFERRED';
            }
            return row.coordStatus === 'ok'
              ? 'OK'
              : row.coordStatus === 'warn'
                ? 'WARN'
                : row.coordStatus === 'bad'
                  ? 'BAD'
                  : 'PENDING';
          }
          return `${row.coordStatus}${row.inferred ? ' inferred' : ''}${row.manualAssigned ? ' manual' : ''}`;
        case 'well':
          return row.well;
        case 'plate':
          return row.plateLabel;
        case 'batch':
          return row.batch ?? '';
        case 'cryosection':
          return row.halfLabel ?? '';
        case 'sampleType':
          return row.sample;
        case 'microsample':
          return row.code ?? '';
        case 'number':
          return row.number ?? '';
        case 'shape':
          return row.shape ?? '';
        case 'collection':
          return row.collection ?? '';
        case 'collectionMethod':
          return row.collectionMethod || COLLECTION_METHOD_OPTIONS[0];
        case 'images':
          return row.images ?? '';
        case 'pixelx':
          if (row.pixelX === undefined) {
            return '';
          }
          return mode === 'export' ? formatNumber(row.pixelX, 0) : row.pixelX.toString();
        case 'pixely':
          if (row.pixelY === undefined) {
            return '';
          }
          return mode === 'export' ? formatNumber(row.pixelY, 0) : row.pixelY.toString();
        case 'xcoord':
          if (row.xCoord === undefined) {
            return '';
          }
          return mode === 'export' ? formatNumber(row.xCoord, 2) : row.xCoord.toString();
        case 'ycoord':
          if (row.yCoord === undefined) {
            return '';
          }
          return mode === 'export' ? formatNumber(row.yCoord, 2) : row.yCoord.toString();
        case 'size':
          if (row.size === undefined) {
            return '';
          }
          return mode === 'export' ? formatNumber(row.size, 2) : row.size.toString();
        case 'notes':
          return row.notes ?? '';
        default:
          return '';
      }
    },
    []
  );

  const filteredMetadataRows = useMemo(() => {
    const query = metadataSearch.trim().toLowerCase();
    return metadataRows.filter((row) => {
      if (row.plateIndex === 0 && !metadataPlate1) {
        return false;
      }
      if (row.plateIndex === 1 && !metadataPlate2) {
        return false;
      }
      if (metadataCryoFilters[row.cryoIndex] === false) {
        return false;
      }
      if (row.sample === 'P' && !metadataP) {
        return false;
      }
      if (row.sample === 'M' && !metadataM) {
        return false;
      }
      if (row.sample === 'Z' && !metadataZ) {
        return false;
      }
      if (row.sample === 'R' && !metadataR) {
        return false;
      }
      if (row.sample === 'N' && !metadataN) {
        return false;
      }
      if (!query) {
        return true;
      }
      if (metadataSearchScope === 'all') {
        return allMetadataColumns.some((column) =>
          getMetadataColumnValue(row, column.key).toLowerCase().includes(query)
        );
      }
      return getMetadataColumnValue(row, metadataSearchScope).toLowerCase().includes(query);
    });
  }, [
    metadataRows,
    metadataSearch,
    metadataSearchScope,
    metadataPlate1,
    metadataPlate2,
    metadataCryoFilters,
    metadataP,
    metadataM,
    metadataZ,
    metadataR,
    metadataN,
    getMetadataColumnValue,
    allMetadataColumns
  ]);

  const updateMetadataNote = (key: string, value: string) => {
    setMetadataNotes((prev) => {
      if (prev[key] === value) {
        return prev;
      }
      return { ...prev, [key]: value };
    });
  };

  const updateCsvCellForCryo = useCallback(
    (
      cryoIndex: number,
      plateIndex: number,
      rowIndex: number,
      colIndex: number,
      updater: (cell: CsvCell) => CsvCell
    ) => {
      setCsvPlatesByCryo((prev) => {
        const next: CsvCell[][][][] = prev.map((plates) =>
          plates.map((plate) => plate.map((row) => row.map((cell) => ({ ...cell }))))
        ) as CsvCell[][][][];
        const current = next[cryoIndex]?.[plateIndex]?.[rowIndex]?.[colIndex] ?? {};
        next[cryoIndex][plateIndex][rowIndex][colIndex] = updater(current);
        return next;
      });
      setCsvPlacementsByCryo((prev) => {
        const next = prev.map((items) => items.map((item) => ({ ...item })));
        const placements = next[cryoIndex]
          .filter(
            (item) =>
              item.plateIndex === plateIndex &&
              item.rowIndex === rowIndex &&
              item.colIndex === colIndex
          )
          .sort((a, b) => (a.sourceOrder ?? -1) - (b.sourceOrder ?? -1));
        const target = placements[placements.length - 1];
        if (!target) {
          return prev;
        }
        const updated = updater(target);
        const targetIndex = next[cryoIndex].findIndex(
          (item) =>
            item.plateIndex === target.plateIndex &&
            item.rowIndex === target.rowIndex &&
            item.colIndex === target.colIndex &&
            item.sourceOrder === target.sourceOrder
        );
        if (targetIndex >= 0) {
          next[cryoIndex][targetIndex] = {
            ...next[cryoIndex][targetIndex],
            ...updated
          };
          return next;
        }
        const fallbackCurrent =
          next[cryoIndex]
            .filter(
              (item) =>
                item.plateIndex === plateIndex &&
                item.rowIndex === rowIndex &&
                item.colIndex === colIndex
            )
            .sort((a, b) => (a.sourceOrder ?? -1) - (b.sourceOrder ?? -1))
            .at(-1) ?? {};
        const fallbackUpdated = updater(fallbackCurrent);
        const fallbackSourceOrder = plateIndex * 1000 + colIndex * 10 + rowIndex;
        next[cryoIndex].push({
          plateIndex,
          rowIndex,
          colIndex,
          rowLetter: PLATE_ROWS[rowIndex],
          size: fallbackUpdated.size,
          images: fallbackUpdated.images,
          preImage: fallbackUpdated.preImage,
          cutImage: fallbackUpdated.cutImage,
          pixelX: fallbackUpdated.pixelX,
          pixelY: fallbackUpdated.pixelY,
          sourceOrder:
            typeof fallbackUpdated.sourceOrder === 'number'
              ? fallbackUpdated.sourceOrder
              : fallbackSourceOrder,
          inferred: fallbackUpdated.inferred,
          inferenceConfirmed: fallbackUpdated.inferenceConfirmed,
          manualAssigned: fallbackUpdated.manualAssigned,
          present:
            typeof fallbackUpdated.present === 'boolean'
              ? fallbackUpdated.present
              : hasCsvCellData(fallbackUpdated)
        });
        return next;
      });
    },
    []
  );

  const openStatusPrompt = useCallback(
    (row: {
      plateIndex: number;
      rowIndex: number;
      colIndex: number;
      cryoIndex: number;
      well: string;
      code?: string;
      images: string;
      pixelX?: number;
      pixelY?: number;
      xCoord?: number;
      yCoord?: number;
      inferred: boolean;
      inferenceConfirmed: boolean;
      manualAssigned: boolean;
      coordStatus: 'ok' | 'bad' | 'pending' | 'warn';
    }) => {
      if (
        !row.images.trim() &&
        row.pixelX === undefined &&
        row.pixelY === undefined &&
        row.xCoord === undefined &&
        row.yCoord === undefined
      ) {
        return;
      }
      setStatusPrompt(row);
    },
    []
  );

  const closeStatusPrompt = useCallback(() => {
    setStatusPrompt(null);
  }, []);

  const confirmStatusPromptInference = useCallback(() => {
    if (!statusPrompt) {
      return;
    }
    updateCsvCellForCryo(
      statusPrompt.cryoIndex,
      statusPrompt.plateIndex,
      statusPrompt.rowIndex,
      statusPrompt.colIndex,
      (cell) => ({
        ...cell,
        inferred: statusPrompt.manualAssigned ? false : true,
        inferenceConfirmed: statusPrompt.manualAssigned ? false : true,
        manualAssigned: false
      })
    );
    setStatusPrompt(null);
  }, [statusPrompt, updateCsvCellForCryo]);

  const unlinkStatusPromptImages = useCallback(() => {
    if (!statusPrompt) {
      return;
    }
    const { cryoIndex, plateIndex, rowIndex, colIndex } = statusPrompt;
    const isManualCoordinateOnly =
      statusPrompt.manualAssigned && isManualCoordinateLabel(statusPrompt.images);
    updateCsvCellForCryo(cryoIndex, plateIndex, rowIndex, colIndex, (cell) => {
      const nextCell: CsvCell = {
        ...cell,
        size: isManualCoordinateOnly ? undefined : cell.size,
        images: undefined,
        preImage: undefined,
        cutImage: undefined,
        pixelX: undefined,
        pixelY: undefined,
        inferred: false,
        inferenceConfirmed: false,
        manualAssigned: false
      };
      return {
        ...nextCell,
        present:
          typeof nextCell.present === 'boolean'
            ? nextCell.present && hasCsvCellData(nextCell)
            : hasCsvCellData(nextCell)
      };
    });
    const key = `${plateIndex}-${rowIndex}-${colIndex}`;
    setCoordinateCache((prev) => {
      if (!(key in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setCoordinateOverridesByCryo((prev) => {
      const current = prev[cryoIndex];
      if (!current?.[key]) {
        return prev;
      }
      const nextMap = { ...current };
      delete nextMap[key];
      return replaceAt(prev, cryoIndex, nextMap);
    });
    setCutPointVisibilityByCryo((prev) => {
      const current = prev[cryoIndex];
      if (!current?.[key]) {
        return prev;
      }
      const nextMap = { ...current };
      delete nextMap[key];
      return replaceAt(prev, cryoIndex, nextMap);
    });
    setSelectedCutIdsByCryo((prev) => {
      const current = new Set(prev[cryoIndex]);
      if (!current.has(key)) {
        return prev;
      }
      current.delete(key);
      return replaceAt(prev, cryoIndex, current);
    });
    setStatusPrompt(null);
  }, [statusPrompt, updateCsvCellForCryo]);

  const closeOrphanAssignmentPrompt = useCallback(() => {
    setOrphanAssignmentPrompt(null);
  }, []);

  const closeManualCoordinatePrompt = useCallback(() => {
    setManualCoordinatePrompt(null);
  }, []);

  useEffect(() => {
    if (!manualCoordinatePrompt) {
      setSelectedManualCoordinateTargetKey(null);
      setManualCoordinateDrafts({ x: '', y: '', size: '5000' });
      return;
    }
    setSelectedManualCoordinateTargetKey(
      manualCoordinatePrompt.targets.length
        ? orphanAssignmentTargetKey(manualCoordinatePrompt.targets[0])
        : null
    );
    setManualCoordinateDrafts({
      x: manualCoordinatePrompt.x.toFixed(2),
      y: manualCoordinatePrompt.y.toFixed(2),
      size: '5000'
    });
  }, [manualCoordinatePrompt]);

  useEffect(() => {
    if (!orphanAssignmentPrompt) {
      setSelectedOrphanAssignmentTargetKey(null);
      setSelectedOrphanAssignmentImageKeys([]);
      setShowAllOrphanAssignmentImages(false);
      setOrphanAssignmentPreviewState({});
      return;
    }
    setSelectedOrphanAssignmentTargetKey(orphanAssignmentPrompt.initialTargetKey ?? null);
    setSelectedOrphanAssignmentImageKeys([]);
    setShowAllOrphanAssignmentImages(false);
  }, [orphanAssignmentPrompt]);

  useEffect(() => {
    setSelectedOrphanAssignmentImageKeys([]);
    setShowAllOrphanAssignmentImages(false);
  }, [selectedOrphanAssignmentTargetKey]);

  const openOrphanAssignmentPrompt = useCallback(
    (orphanId: string, canvasX: number, canvasY: number) => {
      const orphanRect = mapOrphanImageRectsRef.current.find((item) => item.id === orphanId);
      const orphanInfo = orphanAssignmentImagesById.get(orphanId);
      const orphanDisplayInfo = orphanImageInfoById.get(orphanId);
      if (!orphanRect || !orphanInfo || !orphanRect.imageWidth || !orphanRect.imageHeight) {
        setErrorBanner('Unable to resolve orphan image coordinates for manual assignment.');
        return;
      }
      const collector = orphanDisplayInfo?.collector?.trim().toUpperCase();
      const pixelX = Math.round(
        Math.max(
          0,
          Math.min(
            orphanRect.imageWidth - 1,
            ((canvasX - (orphanRect.x - orphanRect.w / 2)) / orphanRect.w) * orphanRect.imageWidth
          )
        )
      );
      const pixelY = Math.round(
        Math.max(
          0,
          Math.min(
            orphanRect.imageHeight - 1,
            ((canvasY - (orphanRect.y - orphanRect.h / 2)) / orphanRect.h) * orphanRect.imageHeight
          )
        )
      );
      const matchingTargets = collector
        ? orphanAssignmentTargets.filter((target) => PLATE_ROWS[target.rowIndex] === collector)
        : orphanAssignmentTargets;
      setManualCoordinatePrompt(null);
      setOrphanAssignmentPrompt({
        mode: 'orphan-click',
        contextLabel: `Clicked ${orphanInfo.orphanName} at X ${pixelX}, Y ${pixelY}.`,
        collector,
        pixelX,
        pixelY,
        targets: matchingTargets,
        imageOptions: buildAssignmentImageOptionsForCryo(activeCryosection, [
          orphanInfo.preImage,
          orphanInfo.cutImage
        ].filter((value): value is string => Boolean(value)))
      });
    },
    [
      activeCryosection,
      buildAssignmentImageOptionsForCryo,
      orphanAssignmentImagesById,
      orphanAssignmentTargets,
      orphanImageInfoById
    ]
  );

  const openManualCoordinatePrompt = useCallback(
    (x: number, y: number) => {
      setOrphanAssignmentPrompt(null);
      setManualCoordinatePrompt({
        x,
        y,
        targets: orphanAssignmentTargets
      });
      setErrorBanner(null);
    },
    [orphanAssignmentTargets]
  );

  const selectedOrphanAssignmentTarget = useMemo(() => {
    if (!orphanAssignmentPrompt || !selectedOrphanAssignmentTargetKey) {
      return null;
    }
    return (
      orphanAssignmentPrompt.targets.find(
        (target) => orphanAssignmentTargetKey(target) === selectedOrphanAssignmentTargetKey
      ) ?? null
    );
  }, [orphanAssignmentPrompt, selectedOrphanAssignmentTargetKey]);

  const orphanAssignmentExpectedImageRange = useMemo(() => {
    if (!orphanAssignmentPrompt || !selectedOrphanAssignmentTarget) {
      return null;
    }
    const targetSourceInfo = getCryoSourceSlotForPlateCell(
      activeCryosection,
      selectedOrphanAssignmentTarget.plateIndex,
      selectedOrphanAssignmentTarget.rowIndex,
      selectedOrphanAssignmentTarget.colIndex
    );
    if (!targetSourceInfo) {
      return null;
    }
    const anchors: Array<{ sourceCol: number; min: number; max: number }> = [];
    const plates = csvPlatesByCryo[activeCryosection] ?? [];
    for (let plateIndex = 0; plateIndex < plates.length; plateIndex += 1) {
      const plate = plates[plateIndex];
      for (let rowIndex = 0; rowIndex < plate.length; rowIndex += 1) {
        const row = plate[rowIndex];
        for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
          if (
            plateIndex === selectedOrphanAssignmentTarget.plateIndex &&
            rowIndex === selectedOrphanAssignmentTarget.rowIndex &&
            colIndex === selectedOrphanAssignmentTarget.colIndex
          ) {
            continue;
          }
          const sourceInfo = getCryoSourceSlotForPlateCell(
            activeCryosection,
            plateIndex,
            rowIndex,
            colIndex
          );
          if (!sourceInfo) {
            continue;
          }
          const sequenceRange = getCsvCellImageSequenceRange(row[colIndex] ?? {});
          if (!sequenceRange) {
            continue;
          }
          anchors.push({
            sourceCol: sourceInfo.sourceCol,
            min: sequenceRange.min,
            max: sequenceRange.max
          });
        }
      }
    }
    const previousColumn = targetSourceInfo.sourceCol - 1;
    const nextColumn = targetSourceInfo.sourceCol + 1;
    const previousAnchors = anchors.filter((anchor) => anchor.sourceCol === previousColumn);
    const nextAnchors = anchors.filter((anchor) => anchor.sourceCol === nextColumn);
    const previousMax =
      previousAnchors.length > 0 ? Math.max(...previousAnchors.map((anchor) => anchor.max)) : undefined;
    const nextMin =
      nextAnchors.length > 0 ? Math.min(...nextAnchors.map((anchor) => anchor.min)) : undefined;
    if (previousMax === undefined && nextMin === undefined) {
      return null;
    }
    return { previousMax, nextMin };
  }, [
    activeCryosection,
    csvPlatesByCryo,
    getCryoSourceSlotForPlateCell,
    orphanAssignmentPrompt,
    selectedOrphanAssignmentTarget
  ]);

  const visibleOrphanAssignmentImageOptions = useMemo(() => {
    const allOptions = orphanAssignmentPrompt?.imageOptions ?? [];
    if (showAllOrphanAssignmentImages || !orphanAssignmentExpectedImageRange) {
      return allOptions;
    }
    const { previousMax, nextMin } = orphanAssignmentExpectedImageRange;
    return allOptions.filter((option) => {
      if (previousMax !== undefined && option.sequence <= previousMax) {
        return false;
      }
      if (nextMin !== undefined && option.sequence >= nextMin) {
        return false;
      }
      return true;
    });
  }, [orphanAssignmentExpectedImageRange, orphanAssignmentPrompt, showAllOrphanAssignmentImages]);

  const orphanAssignmentHiddenImageCount = useMemo(() => {
    const total = orphanAssignmentPrompt?.imageOptions.length ?? 0;
    return Math.max(0, total - visibleOrphanAssignmentImageOptions.length);
  }, [orphanAssignmentPrompt, visibleOrphanAssignmentImageOptions.length]);

  const selectedManualCoordinateTarget = useMemo(() => {
    if (!manualCoordinatePrompt || !selectedManualCoordinateTargetKey) {
      return null;
    }
    return (
      manualCoordinatePrompt.targets.find(
        (target) => orphanAssignmentTargetKey(target) === selectedManualCoordinateTargetKey
      ) ?? null
    );
  }, [manualCoordinatePrompt, selectedManualCoordinateTargetKey]);

  const orphanAssignmentImageOptionsByKey = useMemo(
    () =>
      new Map(
        (orphanAssignmentPrompt?.imageOptions ?? []).map((option) => [option.key, option] as const)
      ),
    [orphanAssignmentPrompt]
  );

  const selectedOrphanAssignmentImages = useMemo(
    () =>
      selectedOrphanAssignmentImageKeys
        .map((key) => orphanAssignmentImageOptionsByKey.get(key))
        .filter((value): value is OrphanAssignmentImageOption => Boolean(value)),
    [orphanAssignmentImageOptionsByKey, selectedOrphanAssignmentImageKeys]
  );

  const assignOrphanImageToTarget = useCallback(() => {
    if (!orphanAssignmentPrompt || !selectedOrphanAssignmentTarget) {
      return;
    }
    const target = selectedOrphanAssignmentTarget;
    const preImage = selectedOrphanAssignmentImages.find((option) => option.group === 'pre')?.imageName;
    const cutImage = selectedOrphanAssignmentImages.find((option) => option.group === 'post')?.imageName;
    if (!preImage && !cutImage) {
      setErrorBanner('Select at least one image before assigning the orphan sample.');
      return;
    }
      manualPointUndoStackRef.current.push({
        csvPlatesByCryo: cloneCsvPlatesByCryo(csvPlatesByCryo),
        csvPlacementsByCryo: cloneCsvPlacementsByCryo(csvPlacementsByCryo),
        coordinateCache: { ...coordinateCache },
        coordinateOverridesByCryo: coordinateOverridesByCryo.map((entry) => ({ ...entry })),
        cutPointVisibilityByCryo: cutPointVisibilityByCryo.map((entry) => ({ ...entry })),
        selectedCutIdsByCryo: selectedCutIdsByCryo.map((entry) => Array.from(entry))
      });
      updateCsvCellForCryo(
        activeCryosection,
        target.plateIndex,
        target.rowIndex,
        target.colIndex,
        (cell) => {
          const pixelX =
            cell.pixelX !== undefined ? cell.pixelX : orphanAssignmentPrompt.pixelX;
          const pixelY =
            cell.pixelY !== undefined ? cell.pixelY : orphanAssignmentPrompt.pixelY;
          return {
            ...cell,
            preImage,
            cutImage,
            images: joinImageNames(preImage, cutImage),
            pixelX,
            pixelY,
            inferred: false,
            inferenceConfirmed: false,
            manualAssigned: true,
            present: true
          };
        }
      );
      const cutId = `${target.plateIndex}-${target.rowIndex}-${target.colIndex}`;
      setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, new Set([cutId])));
      setErrorBanner(null);
      setOrphanAssignmentPrompt(null);
  }, [
    activeCryosection,
    coordinateCache,
    coordinateOverridesByCryo,
    csvPlacementsByCryo,
    csvPlatesByCryo,
    cutPointVisibilityByCryo,
    orphanAssignmentPrompt,
    selectedCutIdsByCryo,
    selectedOrphanAssignmentImages,
    selectedOrphanAssignmentTarget,
    updateCsvCellForCryo
  ]);

  const assignManualCoordinatesToTarget = useCallback(() => {
    if (!manualCoordinatePrompt || !selectedManualCoordinateTarget) {
      return;
    }
    const x = Number.parseFloat(manualCoordinateDrafts.x);
    const y = Number.parseFloat(manualCoordinateDrafts.y);
    const size = Number.parseInt(manualCoordinateDrafts.size, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size) || size <= 0) {
      setErrorBanner('Enter valid X, Y, and Size values before assigning the coordinates.');
      return;
    }
    manualPointUndoStackRef.current.push({
      csvPlatesByCryo: cloneCsvPlatesByCryo(csvPlatesByCryo),
      csvPlacementsByCryo: cloneCsvPlacementsByCryo(csvPlacementsByCryo),
      coordinateCache: { ...coordinateCache },
      coordinateOverridesByCryo: coordinateOverridesByCryo.map((entry) => ({ ...entry })),
      cutPointVisibilityByCryo: cutPointVisibilityByCryo.map((entry) => ({ ...entry })),
      selectedCutIdsByCryo: selectedCutIdsByCryo.map((entry) => Array.from(entry))
    });
    const target = selectedManualCoordinateTarget;
    const cutId = `${target.plateIndex}-${target.rowIndex}-${target.colIndex}`;
    updateCsvCellForCryo(
      activeCryosection,
      target.plateIndex,
      target.rowIndex,
      target.colIndex,
      (cell) => ({
        ...cell,
        images: MANUAL_COORDINATE_LABEL,
        preImage: undefined,
        cutImage: undefined,
        size,
        pixelX: undefined,
        pixelY: undefined,
        inferred: false,
        inferenceConfirmed: false,
        manualAssigned: true,
        present: true
      })
    );
    setCoordinateCache((prev) => ({
      ...prev,
      [cutId]: { x, y }
    }));
    setCoordinateOverridesByCryo((prev) =>
      replaceAt(prev, activeCryosection, {
        ...(prev[activeCryosection] ?? {}),
        [cutId]: true
      })
    );
    setCutPointVisibilityByCryo((prev) =>
      replaceAt(prev, activeCryosection, {
        ...(prev[activeCryosection] ?? {}),
        [cutId]: { point: true, image: false }
      })
    );
    setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, new Set([cutId])));
    setCoordinatesReady(true);
    setManualCoordinatePrompt(null);
    setStatus(`Assigned manual coordinates to ${target.plateLabel} · ${target.well}.`);
    setErrorBanner(null);
  }, [
    activeCryosection,
    coordinateCache,
    coordinateOverridesByCryo,
    csvPlacementsByCryo,
    csvPlatesByCryo,
    cutPointVisibilityByCryo,
    manualCoordinateDrafts.x,
    manualCoordinateDrafts.y,
    manualCoordinateDrafts.size,
    manualCoordinatePrompt,
    selectedCutIdsByCryo,
    selectedManualCoordinateTarget,
    updateCsvCellForCryo
  ]);

  const undoManualPointCreation = useCallback(() => {
    const previous = manualPointUndoStackRef.current.pop();
    if (!previous) {
      return;
    }
    setCsvPlatesByCryo(cloneCsvPlatesByCryo(previous.csvPlatesByCryo));
    setCsvPlacementsByCryo(cloneCsvPlacementsByCryo(previous.csvPlacementsByCryo));
    setCoordinateCache({ ...previous.coordinateCache });
    setCoordinateOverridesByCryo(previous.coordinateOverridesByCryo.map((entry) => ({ ...entry })));
    setCutPointVisibilityByCryo(previous.cutPointVisibilityByCryo.map((entry) => ({ ...entry })));
    setSelectedCutIdsByCryo(previous.selectedCutIdsByCryo.map((entry) => new Set(entry)));
    setOrphanAssignmentPrompt(null);
    setStatus('Undid last manual point creation.');
    setErrorBanner(null);
  }, []);
  undoManualPointCreationRef.current = undoManualPointCreation;

  const showCollectionAreaHint = useCallback(() => {
    if (collectionAreaHintTimerRef.current !== null) {
      window.clearTimeout(collectionAreaHintTimerRef.current);
      collectionAreaHintTimerRef.current = null;
    }
    setCollectionAreaHint(
      'Ensure that the "Synchronize image numbers with collected shapes" in Options > Database is clicked.'
    );
    collectionAreaHintTimerRef.current = window.setTimeout(() => {
      setCollectionAreaHint(null);
      collectionAreaHintTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (collectionAreaHintTimerRef.current !== null) {
        window.clearTimeout(collectionAreaHintTimerRef.current);
      }
    };
  }, []);

  const updateCollectionColumnArea = (plateIndex: number, colIndex: number, value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    setCollectionColumnWarning(null);
    if ((collectionColumnAreas[plateIndex]?.[colIndex] ?? '') !== digits) {
      markCollectionEdited();
    }
    const showHint = digits.length === 4 && isCollectionAreaEntryValid(plateIndex, colIndex, digits);
    setCollectionColumnAreas((prev) => {
      const next: [string[], string[]] = [prev[0].slice(), prev[1].slice()];
      if (next[plateIndex][colIndex] === digits) {
        return prev;
      }
      next[plateIndex][colIndex] = digits;
      return next;
    });
    if (showHint) {
      showCollectionAreaHint();
    }
  };

  const isCollectionColumnNotUsed = useCallback(
    (plateIndex: number, colIndex: number) => {
      const plate = designPlates[plateIndex];
      if (!plate) {
        return false;
      }
      for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
        const sample = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
        if (sample !== DISABLED_SAMPLE) {
          return false;
        }
      }
      return true;
    },
    [designPlates]
  );

  const hasDuplicateCollectionArea = useCallback(
    (plateIndex: number, colIndex: number) => {
      if (colIndex <= 0) {
        return false;
      }
      if (
        isCollectionColumnNotUsed(plateIndex, colIndex) ||
        isCollectionColumnNotUsed(plateIndex, colIndex - 1)
      ) {
        return false;
      }
      const currentArea = (collectionColumnAreas[plateIndex]?.[colIndex] ?? '').trim();
      const previousArea = (collectionColumnAreas[plateIndex]?.[colIndex - 1] ?? '').trim();
      return (
        currentArea.length === 4 &&
        previousArea.length === 4 &&
        currentArea === previousArea
      );
    },
    [collectionColumnAreas, isCollectionColumnNotUsed]
  );

  const isCollectionAreaEntryValid = useCallback(
    (plateIndex: number, colIndex: number, value: string) => {
      if (value.length !== 4) {
        return false;
      }
      if (isCollectionColumnNotUsed(plateIndex, colIndex)) {
        return false;
      }
      const hasEqualNeighbor = (neighborColIndex: number) => {
        if (neighborColIndex < 0 || neighborColIndex >= PLATE_COLS.length) {
          return false;
        }
        if (isCollectionColumnNotUsed(plateIndex, neighborColIndex)) {
          return false;
        }
        const neighbor = (collectionColumnAreas[plateIndex]?.[neighborColIndex] ?? '').trim();
        return neighbor.length === 4 && neighbor === value;
      };
      return !hasEqualNeighbor(colIndex - 1) && !hasEqualNeighbor(colIndex + 1);
    },
    [collectionColumnAreas, isCollectionColumnNotUsed]
  );

  const getCollectionTimeStamp = () =>
    new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const markCollectionEdited = () => {
    const now = getCollectionTimeStamp();
    setCollectionMetadata((prev) => ({
      ...prev,
      startTime: prev.startTimeManual ? prev.startTime : prev.startTime || now,
      endTime: prev.endTimeManual ? prev.endTime : now
    }));
  };

  const updateCollectionMetadataField = (
    key: 'collectionMethod' | 'date' | 'temperature' | 'humidity' | 'notes',
    value: string
  ) => {
    const now = getCollectionTimeStamp();
    setCollectionMetadata((prev) => ({
      ...prev,
      [key]: value,
      startTime: prev.startTimeManual ? prev.startTime : prev.startTime || now,
      endTime: prev.endTimeManual ? prev.endTime : now
    }));
  };

  const updateCollectionTimeField = (key: 'startTime' | 'endTime', value: string) => {
    setCollectionMetadata((prev) => ({
      ...prev,
      [key]: value,
      ...(key === 'startTime'
        ? { startTimeManual: value.length > 0 }
        : { endTimeManual: value.length > 0 })
    }));
  };

  const resolveCollectionImportPlateIndex = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return visiblePlateCount === 1 ? 0 : undefined;
      }
      const numberedMatch = trimmed.match(/^plate\s*(\d+)$/i) ?? trimmed.match(/^(\d+)$/);
      if (numberedMatch) {
        const parsed = Number.parseInt(numberedMatch[1], 10);
        if (parsed >= 1 && parsed <= visiblePlateCount) {
          return parsed - 1;
        }
      }
      const normalized = normalizeHeaderKey(trimmed);
      for (let plateIndex = 0; plateIndex < visiblePlateCount; plateIndex += 1) {
        const label = designPlates[plateIndex]?.label || formatPlateDisplayLabel(plateIndex, '');
        const batchId = plateBatchIds[plateIndex] ?? '';
        if (
          normalized === normalizeHeaderKey(label) ||
          (batchId && normalized === normalizeHeaderKey(batchId))
        ) {
          return plateIndex;
        }
      }
      return undefined;
    },
    [designPlates, plateBatchIds, visiblePlateCount]
  );

  const handleImportCollectionCsv = async () => {
    if (!window.lifApi?.openCsv || !window.lifApi?.readCsv) {
      setError('Preload API unavailable. Check Electron preload setup.');
      setStatus('Preload API unavailable. Check Electron preload setup.');
      setErrorBanner('Preload API unavailable. Check Electron preload setup.');
      return;
    }
    setError(null);
    const picked = await window.lifApi.openCsv();
    const filePath = picked?.[0];
    if (!filePath) {
      return;
    }

    try {
      const text = await window.lifApi.readCsv(filePath);
      const rows = parseCollectionImportCsv(text);
      const nextCollectionPlates: [CollectionCell[][], CollectionCell[][]] = [
        collectionPlates[0].map((row) => row.map((cell) => ({ ...cell }))),
        collectionPlates[1].map((row) => row.map((cell) => ({ ...cell })))
      ];
      const nextAreas: [string[], string[]] = [
        collectionColumnAreas[0].slice(),
        collectionColumnAreas[1].slice()
      ];
      const issues: string[] = [];
      let importedRows = 0;
      let didChange = false;

      for (const row of rows) {
        const plateIndex = resolveCollectionImportPlateIndex(row.plate);
        if (plateIndex === undefined) {
          issues.push(`Unknown plate "${row.plate}".`);
          continue;
        }
        const well = parseCollectionImportWell(row.well);
        if (!well) {
          issues.push(`Unknown well "${row.well}".`);
          continue;
        }
        const counts = parseCollectionImportCounts(
          row.collection,
          collectionMetadata.encodingMode
        );
        if (!counts) {
          issues.push(`Invalid Collection value "${row.collection}" for ${row.plate} ${row.well}.`);
          continue;
        }

        const currentCell = nextCollectionPlates[plateIndex][well.rowIndex][well.colIndex];
        if (
          currentCell.left !== counts.left ||
          currentCell.right !== counts.right ||
          currentCell.rightTouched !== counts.rightTouched
        ) {
          nextCollectionPlates[plateIndex][well.rowIndex][well.colIndex] = counts;
          didChange = true;
        }

        const areaDigits = row.area.replace(/\D/g, '').slice(0, 4);
        if (row.area.trim().length > 0) {
          if (areaDigits.length !== 4) {
            issues.push(`Invalid Area value "${row.area}" for ${row.plate} ${row.well}.`);
          } else {
            const currentArea = nextAreas[plateIndex][well.colIndex];
            if (currentArea && currentArea !== areaDigits) {
              issues.push(
                `Conflicting Area values for ${designPlates[plateIndex]?.label || formatPlateDisplayLabel(plateIndex, plateBatchIds[plateIndex] ?? '')} column ${PLATE_COLS[well.colIndex]}.`
              );
            } else if (currentArea !== areaDigits) {
              nextAreas[plateIndex][well.colIndex] = areaDigits;
              didChange = true;
            }
          }
        }

        importedRows += 1;
      }

      setCollectionColumnWarning(null);
      setCollectionAreaHint(null);
      if (didChange) {
        setCollectionPlates(nextCollectionPlates);
        setCollectionColumnAreas(nextAreas);
        markCollectionEdited();
      }
      setStatus(
        `Imported collection CSV: ${filePath.split(/[\\\\/]/).pop()} (${importedRows} row${importedRows === 1 ? '' : 's'}).`
      );
      setErrorBanner(
        issues.length
          ? `${issues[0]}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`
          : null
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to import collection CSV.';
      setError(message);
      setStatus(message);
      setErrorBanner(message);
    }
  };

  const visibleMetadataColumns = useMemo<MetadataDisplayColumn[]>(
    () => [
      ...orderedBaseMetadataColumns.filter(
        (column) => metadataColumns[column.key as MetadataColumnKey]
      ),
      ...contourMetadataColumns
    ],
    [orderedBaseMetadataColumns, contourMetadataColumns, metadataColumns]
  );
  const orderedMetadataExportColumns = useMemo(
    () => orderMetadataColumns(allMetadataColumns, metadataExportOrder),
    [allMetadataColumns, metadataExportOrder]
  );

  const reorderMetadataColumns = useCallback((draggedKey: string, targetKey: string) => {
    setMetadataColumnOrder((prev) => reorderMetadataColumnKeys(prev, draggedKey, targetKey));
  }, []);

  const reorderMetadataExportColumns = useCallback((draggedKey: string, targetKey: string) => {
    setMetadataExportOrder((prev) => reorderMetadataColumnKeys(prev, draggedKey, targetKey));
  }, []);

  const updateCutPointVisibility = (id: string, field: 'point' | 'image', value: boolean) => {
    setCutPointVisibilityByCryo((prev) => {
      const current = prev[activeCryosection] ?? {};
      const existing = current[id] ?? { point: true, image: true };
      const nextEntry = { ...existing, [field]: value };
      const nextMap = { ...current, [id]: nextEntry };
      return replaceAt(prev, activeCryosection, nextMap);
    });
  };

  const updateOrphanImageVisibility = (id: string, value: boolean) => {
    setOrphanImageVisibilityByCryo((prev) => {
      const current = prev[activeCryosection] ?? {};
      const nextMap = { ...current, [id]: value };
      return replaceAt(prev, activeCryosection, nextMap);
    });
  };

  const setAllOrphanImageVisibility = (value: boolean) => {
    setOrphanImageVisibilityByCryo((prev) => {
      const current = { ...(prev[activeCryosection] ?? {}) };
      for (const row of orphanImageRows) {
        current[row.id] = value;
      }
      return replaceAt(prev, activeCryosection, current);
    });
  };

  const applyFilteredCutPointSelection = (value: boolean) => {
    setCutPointVisibilityByCryo((prev) => {
      const current = { ...(prev[activeCryosection] ?? {}) };
      for (const row of cutPointRows) {
        const existing = current[row.id] ?? { point: true, image: true };
        current[row.id] = { ...existing, point: value, image: value };
      }
      return replaceAt(prev, activeCryosection, current);
    });
  };

  const controlCoordinateIssues = useMemo(() => {
    return metadataRows.filter(
      (row) =>
        (row.sample === 'Z' || row.sample === 'R') &&
        row.xCoord !== undefined &&
        row.yCoord !== undefined
    ).length;
  }, [metadataRows]);

  const positiveMissingCoordinates = useMemo(() => {
    return metadataRows.filter(
      (row) => row.sample === 'P' && (row.xCoord === undefined || row.yCoord === undefined)
    ).length;
  }, [metadataRows]);

  const guessImageMime = (filePath: string): string => {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'png') {
      return 'image/png';
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      return 'image/jpeg';
    }
    if (ext === 'tif' || ext === 'tiff') {
      return 'image/tiff';
    }
    if (ext === 'bmp') {
      return 'image/bmp';
    }
    return 'application/octet-stream';
  };

  const loadOverviewBitmap = async (filePath: string): Promise<ImageBitmap | null> => {
    if (!window.lifApi?.readBinary) {
      setErrorBanner('Binary read API unavailable.');
      return null;
    }
    try {
      const data = await window.lifApi.readBinary(filePath);
      const blob = new Blob([data], { type: guessImageMime(filePath) });
      return await createImageBitmap(blob);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load overview image.';
      setErrorBanner(message);
      return null;
    }
  };

  const pushOverviewHistory = useCallback((state: OverviewState) => {
    const history = overviewHistoryRef.current[activeCryosection];
    history.push(snapshotOverviewState(state));
    if (history.length > 100) {
      history.shift();
    }
  }, [activeCryosection]);

  const setOverviewState = (
    updater: (state: OverviewState) => OverviewState,
    options?: { pushHistory?: boolean }
  ) => {
    const shouldPush = options?.pushHistory !== false;
    if (shouldPush) {
      pushOverviewHistory(overview);
    }
    setOverviewByCryo((prev) => {
      const next = prev.slice();
      const current = prev[activeCryosection];
      const updated = updater({
        ...current,
        pre: { ...current.pre },
        post: { ...current.post }
      });
      next[activeCryosection] = updated;
      return next;
    });
  };

  const updateOverviewLayer = (
    layerKey: 'pre' | 'post',
    updater: (layer: OverviewLayerState) => OverviewLayerState,
    options?: { pushHistory?: boolean }
  ) => {
    setOverviewState((state) => {
      const updateLayer = (key: 'pre' | 'post') => {
        state[key] = updater({ ...state[key] });
      };
      updateLayer(layerKey);
      if (state.linked) {
        updateLayer(layerKey === 'pre' ? 'post' : 'pre');
      }
      return state;
    }, options);
  };

  const setOverviewSelection = (updater: (state: OverviewSelectionState) => OverviewSelectionState) => {
    setOverviewSelectionByCryo((prev) => {
      const next = prev.slice();
      const current = prev[activeCryosection];
      next[activeCryosection] = updater({ ...current });
      return next;
    });
  };

  const getSelectionStageAspect = useCallback(
    (ratio: number) => {
      if (ratio <= 0) {
        return 0;
      }
      const layerRect = getOverviewLayerRect(activeOverviewLayer);
      const bitmap = activeOverviewLayer.bitmap;
      if (!layerRect || !bitmap) {
        return ratio;
      }
      const stagePerPixelX = layerRect.w / bitmap.width;
      const stagePerPixelY = layerRect.h / bitmap.height;
      if (
        !Number.isFinite(stagePerPixelX) ||
        !Number.isFinite(stagePerPixelY) ||
        stagePerPixelY === 0
      ) {
        return ratio;
      }
      return ratio * (stagePerPixelY / stagePerPixelX);
    },
    [activeOverviewLayer, getOverviewLayerRect]
  );

  const updateOverviewSelectionPixelSize = (dimension: 'w' | 'h', value: number) => {
    if (!overviewSelection.rect) {
      return;
    }
    const layerRect = getOverviewLayerRect(activeOverviewLayer);
    if (!layerRect || !activeOverviewLayer.bitmap) {
      return;
    }
    const rect = normalizeRect(overviewSelection.rect);
    const imgW = activeOverviewLayer.bitmap.width;
    const imgH = activeOverviewLayer.bitmap.height;
    const ratioStage =
      overviewSelection.aspect > 0
        ? getSelectionStageAspect(overviewSelection.aspect)
        : rect.h / rect.w || 1;

    const centerX = rect.x + rect.w / 2;
    const centerY = rect.y + rect.h / 2;
    let nextWStage = rect.w;
    let nextHStage = rect.h;

    if (dimension === 'w') {
      nextWStage = (value * layerRect.w) / imgW;
      nextHStage = nextWStage * ratioStage;
    } else {
      nextHStage = (value * layerRect.h) / imgH;
      nextWStage = ratioStage > 0 ? nextHStage / ratioStage : rect.w;
    }

    if (!Number.isFinite(nextWStage) || !Number.isFinite(nextHStage)) {
      return;
    }
    if (nextWStage <= 0 || nextHStage <= 0) {
      return;
    }

    setOverviewSelection((state) => ({
      ...state,
      rect: {
        x: centerX - nextWStage / 2,
        y: centerY - nextHStage / 2,
        w: nextWStage,
        h: nextHStage
      }
    }));
    updateOverview();
  };

  const updateOverviewExportSize = (dimension: 'w' | 'h', value: number) => {
    const baseSize =
      overviewSelectionSizePx ??
      (overviewCrop.rectPx ? { w: overviewCrop.rectPx.w, h: overviewCrop.rectPx.h } : null);
    if (!baseSize) {
      return;
    }
    const ratio = baseSize.h / baseSize.w;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return;
    }
    const next = overviewExport ?? { w: baseSize.w, h: baseSize.h };
    let w = next.w;
    let h = next.h;
    if (dimension === 'w') {
      w = value;
      if (overviewSelection.aspect > 0) {
        h = value * ratio;
      }
    } else {
      h = value;
      if (overviewSelection.aspect > 0) {
        w = value / ratio;
      }
    }
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return;
    }
    setOverviewExportByCryo((prev) => {
      const nextState = prev.slice();
      nextState[activeCryosection] = { w, h };
      return nextState;
    });
  };

  const updateOverviewContours = useCallback((
    updater: (contours: OverviewContour[]) => OverviewContour[]
  ) => {
    setOverviewContoursByCryo((prev) => {
      const next = prev.slice();
      const current = prev[activeCryosection] ?? [];
      next[activeCryosection] = updater(current.map((contour) => ({ ...contour, points: [...contour.points] })));
      return next;
    });
  }, [activeCryosection]);

  const setActiveOverviewContour = useCallback((contourId: string | null) => {
    setActiveOverviewContourByCryo((prev) => replaceAt(prev, activeCryosection, contourId));
  }, [activeCryosection]);

  const setActiveOverviewContourAnchor = useCallback((
    anchor: { contourId: string; pointIndex: number } | null
  ) => {
    setActiveOverviewContourAnchorByCryo((prev) => replaceAt(prev, activeCryosection, anchor));
  }, [activeCryosection]);

  const setHoveredOverviewContourAnchor = useCallback((
    anchor: { contourId: string; pointIndex: number } | null
  ) => {
    setHoveredOverviewContourAnchorByCryo((prev) => replaceAt(prev, activeCryosection, anchor));
  }, [activeCryosection]);

  const setOverviewContourInsertPreview = useCallback((
    preview: { contourId: string; pointIndex: number; x: number; y: number } | null
  ) => {
    setOverviewContourInsertPreviewByCryo((prev) => replaceAt(prev, activeCryosection, preview));
  }, [activeCryosection]);

  const setOverviewContourPreview = useCallback((point: { x: number; y: number } | null) => {
    setOverviewContourPreviewByCryo((prev) => replaceAt(prev, activeCryosection, point));
  }, [activeCryosection]);

  const startOverviewContour = () => {
    if (overviewSelection.enabled) {
      setOverviewSelection((state) => ({ ...state, enabled: false }));
      overviewSelectionRef.current.isSelecting = false;
    }
    const nextIndex = overviewContours.length + 1;
    const contour: OverviewContour = {
      id: `contour_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: getDefaultContourName(nextIndex - 1),
      color: pickOverviewContourColor(nextIndex - 1),
      visible: true,
      closed: false,
      points: []
    };
    updateOverviewContours((contours) => [...contours, contour]);
    setActiveOverviewContour(contour.id);
    setActiveOverviewContourAnchor(null);
    setHoveredOverviewContourAnchor(null);
    setOverviewContourInsertPreview(null);
    setOverviewContourPreview(null);
  };

  const finishOverviewContour = () => {
    if (!activeOverviewContourId) {
      return;
    }
    updateOverviewContours((contours) =>
      contours.filter((contour) => contour.id !== activeOverviewContourId || contour.points.length >= 2)
    );
    setActiveOverviewContour(null);
    setActiveOverviewContourAnchor(null);
    setHoveredOverviewContourAnchor(null);
    setOverviewContourInsertPreview(null);
    setOverviewContourPreview(null);
    updateOverviewRef.current();
  };

  const removeOverviewContour = (contourId: string) => {
    updateOverviewContours((contours) => contours.filter((contour) => contour.id !== contourId));
    if (activeOverviewContourId === contourId) {
      setActiveOverviewContour(null);
      setActiveOverviewContourAnchor(null);
      setHoveredOverviewContourAnchor(null);
      setOverviewContourInsertPreview(null);
      setOverviewContourPreview(null);
    }
  };

  const startSession = useCallback(
    (baseSessions: SessionEntry[] = sessions, usersOverride?: string[]) => {
      const users = normalizeUserList(usersOverride ?? selectedSessionUsers);
      if (!users.length) {
        return null;
      }
      const session = createSession(users);
      const nextSessions = [...baseSessions, session];
      setSessions(nextSessions);
      setSelectedSessionUsers(users);
      setCurrentSessionId(session.id);
      setSelectedSessionId(session.id);
      return session;
    },
    [selectedSessionUsers, sessions]
  );

  const ensureUser = useCallback(
    (action: 'new' | 'load', filePath?: string) => {
      if (selectedSessionUsers.length > 0) {
        return true;
      }
      pendingLoadPathRef.current = action === 'load' ? filePath ?? null : null;
      setPendingAction(action);
      setUserPromptOpen(true);
      return false;
    },
    [selectedSessionUsers]
  );

  useEffect(() => {
    if (overviewSelection.rect && !overviewExport) {
      setOverviewExportByCryo((prev) => {
        const next = prev.slice();
        if (!next[activeCryosection]) {
          next[activeCryosection] = getDefaultExportSize();
        }
        return next;
      });
    }
  }, [overviewSelection.rect, overviewExport, activeCryosection, getDefaultExportSize]);

  const setOverviewSelectionEnabled = (enabled: boolean) => {
    if (enabled && activeOverviewContourId) {
      finishOverviewContour();
    }
    setOverviewSelection((state) => ({ ...state, enabled }));
    if (!enabled) {
      overviewSelectionRef.current.isSelecting = false;
      overviewDragRef.current.isDragging = false;
      const canvas = overviewCanvasRef.current;
      if (canvas) {
        canvas.style.cursor = '';
      }
    }
  };

  const setOverviewSelectionAspect = (value: number) => {
    setOverviewSelection((state) => {
      if (!state.rect || value <= 0) {
        return { ...state, aspect: value };
      }
      const rect = normalizeRect(state.rect);
      const stageAspect = getSelectionStageAspect(value);
      if (stageAspect <= 0 || !Number.isFinite(stageAspect)) {
        return { ...state, aspect: value };
      }
      const centerX = rect.x + rect.w / 2;
      const centerY = rect.y + rect.h / 2;
      const width = rect.w;
      const height = width * stageAspect;
      return {
        ...state,
        aspect: value,
        rect: {
          x: centerX - width / 2,
          y: centerY - height / 2,
          w: width,
          h: height
        }
      };
    });
    updateOverview();
  };

  const nudgeOverviewScale = (axis: 'x' | 'y', delta: number) => {
    updateOverviewLayer(overview.activeLayer, (layer) => ({
      ...layer,
      scaleX:
        axis === 'x' ? clampValue(layer.scaleX + delta, 0.4, 1.6) : layer.scaleX,
      scaleY:
        axis === 'y' ? clampValue(layer.scaleY + delta, 0.4, 1.6) : layer.scaleY
    }));
  };

  const nudgeOverviewOffset = (axis: 'x' | 'y', delta: number) => {
    updateOverviewLayer(overview.activeLayer, (layer) => ({
      ...layer,
      offsetX: axis === 'x' ? layer.offsetX + delta : layer.offsetX,
      offsetY: axis === 'y' ? layer.offsetY + delta : layer.offsetY
    }));
  };

  const updateOverviewAlignmentDraft = (field: OverviewAlignmentField, value: string) => {
    setOverviewAlignmentDrafts((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const commitOverviewAlignmentDraft = (field: OverviewAlignmentField) => {
    const rawValue = overviewAlignmentDrafts[field].trim();
    const fallbackValue = formatOverviewAlignmentValue(field, activeOverviewLayer[field]);
    if (!rawValue) {
      setOverviewAlignmentDrafts((prev) => ({
        ...prev,
        [field]: fallbackValue
      }));
      return;
    }
    const nextValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(nextValue)) {
      setOverviewAlignmentDrafts((prev) => ({
        ...prev,
        [field]: fallbackValue
      }));
      return;
    }
    const normalizedValue =
      field === 'scaleX' || field === 'scaleY' ? clampValue(nextValue, 0.4, 1.6) : nextValue;
    updateOverviewLayer(overview.activeLayer, (layer) => ({
      ...layer,
      [field]: normalizedValue
    }));
    setOverviewAlignmentDrafts((prev) => ({
      ...prev,
      [field]: formatOverviewAlignmentValue(field, normalizedValue)
    }));
  };

  const handleOverviewAlignmentInputKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    field: OverviewAlignmentField
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitOverviewAlignmentDraft(field);
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOverviewAlignmentDrafts((prev) => ({
        ...prev,
        [field]: formatOverviewAlignmentValue(field, activeOverviewLayer[field])
      }));
      setEditingOverviewAlignmentField(null);
      event.currentTarget.blur();
    }
  };

  const setOverviewLinked = (linked: boolean) => {
    setOverviewState((state) => {
      state.linked = linked;
      if (linked) {
        const source = state[state.activeLayer];
        const otherKey = state.activeLayer === 'pre' ? 'post' : 'pre';
        state[otherKey] = {
          ...state[otherKey],
          offsetX: source.offsetX,
          offsetY: source.offsetY,
          scaleX: source.scaleX,
          scaleY: source.scaleY
        };
      }
      return state;
    });
  };

  const buildOverviewCrop = () => {
    if (!overviewSelection.rect) {
      setErrorBanner('Draw a selection rectangle before computing a crop.');
      return null;
    }
    const layer = overview.activeLayer;
    const layerState = overview[layer];
    const layerRect = getOverviewLayerRect(layerState);
    if (!layerRect || !layerState.bitmap) {
      setErrorBanner('Load an overview image before computing a crop.');
      return null;
    }
    const imgW = layerState.bitmap.width;
    const imgH = layerState.bitmap.height;
    const rect = normalizeRect(overviewSelection.rect);
    if (rect.w <= 0 || rect.h <= 0) {
      setErrorBanner('Selection rectangle has zero size.');
      return null;
    }
    const cropX = ((rect.x - layerRect.x) / layerRect.w) * imgW;
    const cropY = ((rect.y - layerRect.y) / layerRect.h) * imgH;
    const cropW = (rect.w / layerRect.w) * imgW;
    const cropH = (rect.h / layerRect.h) * imgH;
    const clampedX = Math.max(0, cropX);
    const clampedY = Math.max(0, cropY);
    const clampedW = Math.max(1, Math.min(cropW, imgW - clampedX));
    const clampedH = Math.max(1, Math.min(cropH, imgH - clampedY));
    const sourceRectPx = {
      x: clampedX,
      y: clampedY,
      w: clampedW,
      h: clampedH
    };
    const exportTarget = overviewExport ?? { w: clampedW, h: clampedH };
    const scaleX = exportTarget.w / clampedW;
    const scaleY = exportTarget.h / clampedH;
    const rectPx = {
      x: 0,
      y: 0,
      w: exportTarget.w,
      h: exportTarget.h
    };
    const cuts = overviewCutPoints
      .filter((point) => pointInRect({ x: point.x, y: point.y }, rect))
      .map((point) => {
        const px =
          (((point.x - layerRect.x) / layerRect.w) * imgW - sourceRectPx.x) * scaleX;
        const py =
          (((point.y - layerRect.y) / layerRect.h) * imgH - sourceRectPx.y) * scaleY;
        return {
          id: point.id,
          well: point.well,
          code: point.code,
          plateLabel: point.plateLabel,
          x: px,
          y: py
        };
      });
    setErrorBanner(null);
    return { rectPx, sourceRectPx, cuts, layer, bitmap: layerState.bitmap };
  };

  const computeOverviewCrop = () => {
    const result = buildOverviewCrop();
    if (!result) {
      return;
    }
    setOverviewCropByCryo((prev) => {
      const next = prev.slice();
      next[activeCryosection] = {
        rectPx: result.rectPx,
        cuts: result.cuts,
        layer: result.layer
      };
      return next;
    });
    setOverviewExportByCryo((prev) => {
      const next = prev.slice();
      if (!next[activeCryosection] && result.rectPx) {
        next[activeCryosection] = getDefaultExportSize();
      }
      return next;
    });
  };

  const handleExportCropImage = async () => {
    if (!window.lifApi?.exportFile) {
      setStatus('Export not available.');
      return;
    }
    if (!overviewSelection.rect) {
      setErrorBanner('Draw a selection rectangle before exporting a crop.');
      return;
    }
    const rect = normalizeRect(overviewSelection.rect);
    if (rect.w <= 0 || rect.h <= 0) {
      setErrorBanner('Selection rectangle has zero size.');
      return;
    }
    const visibleLayers = ([
      overview.showPre ? { key: 'pre' as const, state: overview.pre } : null,
      overview.showPost ? { key: 'post' as const, state: overview.post } : null
    ].filter((value): value is { key: 'pre' | 'post'; state: OverviewLayerState } => Boolean(value)))
      .map((entry) => {
        const layerRect = getOverviewLayerRect(entry.state);
        return layerRect && entry.state.bitmap
          ? { ...entry, layerRect, bitmap: entry.state.bitmap }
          : null;
      })
      .filter(
        (
          value
        ): value is {
          key: 'pre' | 'post';
          state: OverviewLayerState;
          layerRect: NonNullable<ReturnType<typeof getOverviewLayerRect>>;
          bitmap: ImageBitmap;
        } => Boolean(value)
      );
    if (visibleLayers.length === 0) {
      setErrorBanner('Show at least one loaded overview image before exporting a crop.');
      return;
    }
    setErrorBanner(null);
    const referenceLayer =
      visibleLayers.find((entry) => entry.key === overview.activeLayer) ?? visibleLayers[0];
    const imgW = referenceLayer.bitmap.width;
    const imgH = referenceLayer.bitmap.height;
    const cropX = ((rect.x - referenceLayer.layerRect.x) / referenceLayer.layerRect.w) * imgW;
    const cropY = ((rect.y - referenceLayer.layerRect.y) / referenceLayer.layerRect.h) * imgH;
    const cropW = (rect.w / referenceLayer.layerRect.w) * imgW;
    const cropH = (rect.h / referenceLayer.layerRect.h) * imgH;
    const clampedX = Math.max(0, cropX);
    const clampedY = Math.max(0, cropY);
    const clampedW = Math.max(1, Math.min(cropW, imgW - clampedX));
    const clampedH = Math.max(1, Math.min(cropH, imgH - clampedY));
    const cryoName = getCryosectionName(activeCryosection);
    const baseName = safeFilename(cryoName || '', `Cryosection${activeCryosection + 1}`);
    const targetSize = overviewExport ?? { w: clampedW, h: clampedH };
    const width = Math.max(1, Math.round(targetSize.w));
    const height = Math.max(1, Math.round(targetSize.h));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setStatus('Failed to prepare export canvas.');
      return;
    }
    ctx.clearRect(0, 0, width, height);
    for (const layer of visibleLayers) {
      const layerLeft = Math.min(layer.layerRect.x, layer.layerRect.x + layer.layerRect.w);
      const layerRight = Math.max(layer.layerRect.x, layer.layerRect.x + layer.layerRect.w);
      const layerTop = Math.min(layer.layerRect.y, layer.layerRect.y + layer.layerRect.h);
      const layerBottom = Math.max(layer.layerRect.y, layer.layerRect.y + layer.layerRect.h);
      const interLeft = Math.max(rect.x, layerLeft);
      const interRight = Math.min(rect.x + rect.w, layerRight);
      const interTop = Math.max(rect.y, layerTop);
      const interBottom = Math.min(rect.y + rect.h, layerBottom);
      if (interRight <= interLeft || interBottom <= interTop) {
        continue;
      }
      const sourceX =
        ((interLeft - layer.layerRect.x) / layer.layerRect.w) * layer.bitmap.width;
      const sourceY =
        ((interTop - layer.layerRect.y) / layer.layerRect.h) * layer.bitmap.height;
      const sourceW =
        ((interRight - interLeft) / layer.layerRect.w) * layer.bitmap.width;
      const sourceH =
        ((interBottom - interTop) / layer.layerRect.h) * layer.bitmap.height;
      const destX = ((interLeft - rect.x) / rect.w) * width;
      const destY = ((interTop - rect.y) / rect.h) * height;
      const destW = ((interRight - interLeft) / rect.w) * width;
      const destH = ((interBottom - interTop) / rect.h) * height;
      ctx.drawImage(
        layer.bitmap,
        sourceX,
        sourceY,
        sourceW,
        sourceH,
        destX,
        destY,
        destW,
        destH
      );
    }
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1] ?? '';
    const response = await window.lifApi.exportFile({
      data: base64,
      encoding: 'base64',
      defaultPath: `${baseName}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if ('error' in response) {
      setStatus(response.error);
      return;
    }
    if ('canceled' in response) {
      return;
    }
    setStatus(`Exported image: ${response.filePath.split(/[\\\\/]/).pop()}`);
  };

  const handleExportCropCsv = async () => {
    if (!window.lifApi?.exportFile) {
      setStatus('Export not available.');
      return;
    }
    const result = buildOverviewCrop();
    if (!result) {
      return;
    }
    const cryoName = getCryosectionName(activeCryosection);
    const baseName = safeFilename(cryoName || '', `Cryosection${activeCryosection + 1}`);
    const lines = [
      ['Plate', 'Well', 'Microsample', 'PixelX', 'PixelY'].map(csvEscape).join(',')
    ];
    for (const cut of result.cuts) {
      lines.push(
        [
          cut.plateLabel ?? '',
          cut.well ?? '',
          cut.code ?? '',
          Number.isFinite(cut.x) ? cut.x.toFixed(2) : '',
          Number.isFinite(cut.y) ? cut.y.toFixed(2) : ''
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    const response = await window.lifApi.exportFile({
      data: lines.join('\n'),
      encoding: 'utf8',
      defaultPath: `${baseName}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if ('error' in response) {
      setStatus(response.error);
      return;
    }
    if ('canceled' in response) {
      return;
    }
    setStatus(`Exported CSV: ${response.filePath.split(/[\\\\/]/).pop()}`);
  };

  const openMetadataExportPopup = useCallback(() => {
    const orderedKeys = allMetadataColumns.map((column) => column.key);
    const visibleKeys = new Set(visibleMetadataColumns.map((column) => column.key));
    const defaultSelected = visibleKeys.size > 0 ? visibleKeys : new Set(orderedKeys);
    setMetadataColumnsPopupOpen(false);
    setMetadataFiltersPopupOpen(false);
    setMetadataExportOrder(orderedKeys);
    setMetadataExportColumns(
      Object.fromEntries(orderedKeys.map((key) => [key, defaultSelected.has(key)]))
    );
    setDraggedMetadataExportKey(null);
    setMetadataExportPopupOpen(true);
  }, [allMetadataColumns, visibleMetadataColumns]);

  const exportMetadataCsv = async (columnsToExport: MetadataDisplayColumn[]) => {
    if (!window.lifApi?.exportFile) {
      setStatus('Export not available.');
      return;
    }
    const lines = [
      columnsToExport.map((column) => csvEscape(column.label)).join(',')
    ];
    for (const row of filteredMetadataRows) {
      lines.push(
        columnsToExport
          .map((column) => csvEscape(getMetadataColumnValue(row, column.key, 'export')))
          .join(',')
      );
    }
    const baseName = safeFilename(projectName || '', 'metadata');
    const response = await window.lifApi.exportFile({
      data: lines.join('\n'),
      encoding: 'utf8',
      defaultPath: `${baseName}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if ('error' in response) {
      setStatus(response.error);
      return;
    }
    if ('canceled' in response) {
      return;
    }
    setStatus(`Exported CSV: ${response.filePath.split(/[\\\\/]/).pop()}`);
  };

  const handleExportMetadataCsv = async () => {
    const orderedColumns = orderMetadataColumns(allMetadataColumns, metadataExportOrder);
    const columnsToExport = orderedColumns.filter(
      (column) => metadataExportColumns[column.key] !== false
    );
    if (!columnsToExport.length) {
      setStatus('Select at least one metadata column to export.');
      return;
    }
    await exportMetadataCsv(columnsToExport);
    setMetadataExportPopupOpen(false);
  };

  const handleExportDesignPlateCsv = async (plateIndex: number) => {
    if (!window.lifApi?.exportFile) {
      setStatus('Export not available.');
      return;
    }
    const plate = designPlates[plateIndex];
    if (!plate) {
      return;
    }
    const lines: string[] = [];
    const split = isPlateSplit(plateIndex);
    const leftCryosection = getPlateSegmentLabel(plateIndex, 0);
    const rightCryosection = split ? getPlateSegmentLabel(plateIndex, 1) : leftCryosection;
    lines.push(['Plate', plate.label || `Plate ${plateIndex + 1}`].map(csvEscape).join(','));
    lines.push(['Cryosection left', leftCryosection].map(csvEscape).join(','));
    lines.push(['Cryosection right', rightCryosection].map(csvEscape).join(','));
    lines.push(['Notes', plate.notes].map(csvEscape).join(','));
    lines.push('');
    lines.push(
      ['Well', 'Row', 'Column', 'SampleType', 'Cryosection', 'Microsample']
        .map(csvEscape)
        .join(',')
    );
    for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
      for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
        const row = PLATE_ROWS[rowIndex];
        const col = PLATE_COLS[colIndex];
        const sample = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
        const cryosection = getCryosectionName(getCellCryoIndex(plateIndex, colIndex));
        const microsample = codeMap.get(`${plateIndex}-${rowIndex}-${colIndex}`) ?? '';
        lines.push(
          [`${col}${row}`, row, col, sample, cryosection, microsample]
            .map(csvEscape)
            .join(',')
        );
      }
    }

    const baseName = safeFilename(plate.label || `Plate${plateIndex + 1}`, `Plate${plateIndex + 1}`);
    const response = await window.lifApi.exportFile({
      data: lines.join('\n'),
      encoding: 'utf8',
      defaultPath: `${baseName}_configuration.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if ('error' in response) {
      setStatus(response.error);
      return;
    }
    if ('canceled' in response) {
      return;
    }
    setStatus(`Exported plate CSV: ${response.filePath.split(/[\\\\/]/).pop()}`);
  };

  const undoOverview = async () => {
    const history = overviewHistoryRef.current[activeCryosection];
    const snapshot = history.pop();
    if (!snapshot) {
      return;
    }
    const current = overview;
    setOverviewByCryo((prev) => {
      const next = prev.slice();
      next[activeCryosection] = restoreOverviewState(snapshot, prev[activeCryosection]);
      return next;
    });
    if (snapshot.pre.filePath && snapshot.pre.filePath !== current.pre.filePath) {
      const bitmap = await loadOverviewBitmap(snapshot.pre.filePath);
      if (bitmap) {
        setOverviewByCryo((prev) => {
          const next = prev.slice();
          const state = { ...next[activeCryosection] };
          state.pre = { ...state.pre, bitmap };
          next[activeCryosection] = state;
          return next;
        });
      }
    }
    if (snapshot.post.filePath && snapshot.post.filePath !== current.post.filePath) {
      const bitmap = await loadOverviewBitmap(snapshot.post.filePath);
      if (bitmap) {
        setOverviewByCryo((prev) => {
          const next = prev.slice();
          const state = { ...next[activeCryosection] };
          state.post = { ...state.post, bitmap };
          next[activeCryosection] = state;
          return next;
        });
      }
    }
    updateOverviewRef.current();
  };
  undoOverviewRef.current = undoOverview;

  const hydrateOverviewImages = async (states: OverviewState[]) => {
    for (let cryoIndex = 0; cryoIndex < Math.min(states.length, MAX_CRYOSECTIONS); cryoIndex += 1) {
      for (const layerKey of ['pre', 'post'] as const) {
        const filePath = states[cryoIndex][layerKey].filePath;
        if (!filePath) {
          continue;
        }
        const bitmap = await loadOverviewBitmap(filePath);
        if (!bitmap) {
          continue;
        }
        setOverviewByCryo((prev) => {
          const next = prev.slice();
          const current = { ...next[cryoIndex] };
          current[layerKey] = { ...current[layerKey], bitmap };
          next[cryoIndex] = current;
          return next;
        });
      }
    }
  };

  const buildBasePayload = useCallback(
    (sessionsOverride?: SessionEntry[]) => ({
      app: 'LMDmapper',
      version: APP_VERSION,
      project: {
        name: projectName,
        description: projectDescription,
        cryosectionCount,
        plateCount,
        cryosections,
        plateBatchIds,
        plateAssignments,
        type: projectType
      },
      cryosectionData: createCryoStateArray((index) => ({
        lifFiles: lifFilesByCryo[index] ?? [],
        csvFiles: csvFilesByCryo[index] ?? [],
        csvSourceGroupId: csvSourceGroupIdsByCryo[index] ?? undefined,
        csvPlates: csvPlatesByCryo[index] ?? [createCsvCells(), createCsvCells()],
        csvPlacements: csvPlacementsByCryo[index] ?? []
      })),
      designPlates,
      collectionPlates,
      collectionPlateNotes,
      collectionColumnAreas,
      collectionMetadata,
      coordinateCache,
      coordinateOverrides: coordinateOverridesByCryo,
      metadataFilters: {
        search: metadataSearch,
        searchColumn: metadataSearchScope,
        plate1: metadataPlate1,
        plate2: metadataPlate2,
        cryoFilters: metadataCryoFilters,
        sampleP: metadataP,
        sampleM: metadataM,
        sampleZ: metadataZ,
        sampleR: metadataR,
        sampleN: metadataN,
        columns: metadataColumns,
        columnOrder: metadataColumnOrder
      },
      metadataNotes,
      viewSettings: {
        imageOpacity,
        micronsPerPixel,
        showCutPoints,
        showCutLabels,
        showCoordinateOrphanPreImages,
        showCoordinateOrphanPostImages,
        coordinateOrphanCollectorFilter,
        filterPre,
        filterPost,
        collectionPlateLocks,
        randomAssignmentSettings
      },
      cutPointVisibility: cutPointVisibilityByCryo,
      orphanImageVisibility: orphanImageVisibilityByCryo,
      overview: overviewByCryo.map((state) => serializeOverviewState(state)),
      overviewSelection: overviewSelectionByCryo.map((state) => serializeOverviewSelection(state)),
      overviewCrop: overviewCropByCryo.map((state) => serializeOverviewCrop(state)),
      overviewContours: overviewContoursByCryo.map((contours) => serializeOverviewContours(contours)),
      overviewExportSize: overviewExportByCryo,
      sessions: sessionsOverride ?? sessions
    }),
    [
      projectName,
      projectDescription,
      cryosectionCount,
      plateCount,
      cryosections,
      plateBatchIds,
      plateAssignments,
      projectType,
      lifFilesByCryo,
      csvFilesByCryo,
      csvSourceGroupIdsByCryo,
      csvPlatesByCryo,
      csvPlacementsByCryo,
      designPlates,
      collectionPlates,
      collectionPlateNotes,
      collectionColumnAreas,
      collectionMetadata,
      coordinateCache,
      coordinateOverridesByCryo,
      metadataSearch,
      metadataSearchScope,
      metadataPlate1,
      metadataPlate2,
      metadataCryoFilters,
      metadataP,
      metadataM,
      metadataZ,
      metadataR,
      metadataN,
      metadataColumns,
      metadataColumnOrder,
      metadataNotes,
      imageOpacity,
      micronsPerPixel,
      showCutPoints,
      showCutLabels,
      showCoordinateOrphanPreImages,
      showCoordinateOrphanPostImages,
      coordinateOrphanCollectorFilter,
      filterPre,
      filterPost,
      collectionPlateLocks,
      randomAssignmentSettings,
      cutPointVisibilityByCryo,
      orphanImageVisibilityByCryo,
      overviewByCryo,
      overviewSelectionByCryo,
      overviewCropByCryo,
      overviewContoursByCryo,
      overviewExportByCryo,
      sessions
    ]
  );

  const buildSavePayload = useCallback(
    (sessionsOverride?: SessionEntry[], historyOverride?: HistoryEntry[]) => ({
      ...buildBasePayload(sessionsOverride),
      history: historyOverride ?? projectHistory
    }),
    [buildBasePayload, projectHistory]
  );

  const handleSaveProject = async (mode: 'save' | 'saveAs' = 'save') => {
    if (!window.lifApi?.saveProject) {
      setStatus('Save not available.');
      return;
    }
    const basePayload = buildBasePayload();
    const savedAt = new Date().toISOString();
    const activeSessionUsers =
      sessions.find((session) => session.id === currentSessionId)?.users ?? selectedSessionUsers;
    const historyEntry = createHistoryEntry(
      basePayload,
      savedAt,
      activeSessionUsers.length ? formatSessionUsers(activeSessionUsers) : undefined,
      currentSessionId || undefined
    );
    const nextHistory = appendHistoryEntry(projectHistory, historyEntry);
    const payload = {
      ...buildSavePayload(undefined, nextHistory),
      savedAt
    };
    const response: LmdSaveResponse = await window.lifApi.saveProject({
      payload,
      filePath: mode === 'save' ? lastSavedPath ?? undefined : undefined,
      forceDialog: mode === 'saveAs'
    });
    if ('error' in response) {
      setStatus(response.error);
      return;
    }
    if ('canceled' in response) {
      return;
    }
    setProjectHistory(nextHistory);
    setLastSavedPath(response.filePath);
    setStatus(`Saved session: ${response.filePath.split(/[\\\\/]/).pop()}`);
    setLastSavedSnapshot(JSON.stringify(basePayload));
    setHasUnsavedChanges(false);
  };

  const handleNewProject = (usersOverride?: string[]) => {
    if (!usersOverride && !ensureUser('new')) {
      return;
    }
    const sessionUsers = normalizeUserList(usersOverride ?? selectedSessionUsers);
    setDesignLocked(false);
    setProjectName('New session');
    setProjectDescription('');
    setCryosectionCount(2);
    setCryosections(createCryosectionConfigs());
    setPlateCount(2);
    setPlateBatchIds(['', '']);
    setPlateAssignments(createPlateAssignments());
    setSelectedProjectSegment({ plateIndex: 0, segmentIndex: 0 });
    setRandomAssignmentSettings({
      M: 2,
      Z: 2,
      R: 2,
      maxControlsPerColumn: 1,
      sustainabilityMode: true
    });
    setActiveCryosection(0);
    setCoordinateFrameMode('images');
    setLifFilesByCryo(createCryoStateArray(() => []));
    setCsvFilesByCryo(createCryoStateArray(() => []));
    setCsvSourceGroupIdsByCryo(createCryoStateArray(() => null));
    setElementsByCryo(createCryoStateArray(() => []));
    setSelectedIdByCryo(createCryoStateArray(() => null));
    setSelectedIdsByCryo(createCryoStateArray(() => new Set()));
    setSelectedCutIdsByCryo(createCryoStateArray(() => new Set()));
    setCutPointVisibilityByCryo(createCryoStateArray(() => ({})));
    setSearch('');
    setMetadataSearchScope('all');
    setMetadataCryoFilters(createCryoStateArray(() => true));
    setMetadataP(true);
    setMetadataM(true);
    setMetadataZ(true);
    setMetadataR(true);
    setMetadataN(true);
    setStatus(EMPTY_STATE);
    setError(null);
    setDesignPlates(createDefaultDesignPlates());
    setCollectionPlateNotes(['', '']);
    setCollectionColumnAreas(createCollectionColumnAreas());
    setCollectionColumnWarning(null);
    setCollectionMetadata(EMPTY_COLLECTION_METADATA);
    setLegacyCollectionPrompt(null);
    setDetachCryoPromptOpen(false);
    setCollapsedPlates([true, true]);
    setCollectionPlates([createCollectionCells(), createCollectionCells()]);
    manualPointUndoStackRef.current = [];
    setCsvPlatesByCryo(createCryoStateArray(() => [createCsvCells(), createCsvCells()]));
    setCsvPlacementsByCryo(createCryoStateArray(() => []));
    setOrphanImageVisibilityByCryo(createCryoStateArray(() => ({})));
    setLastSavedPath(null);
    setCoordinatesReady(false);
    setCoordinateCache({});
    setCoordinateOverridesByCryo(createCryoStateArray(() => ({})));
    setCutPointVisibilityByCryo(createCryoStateArray(() => ({})));
    setShowCoordinateOrphanPreImages(true);
    setShowCoordinateOrphanPostImages(true);
    setCoordinateOrphanCollectorFilter('all');
    setCollectionPlateLocks([false, false]);
    setMetadataColumns({ ...DEFAULT_METADATA_COLUMNS });
    setMetadataColumnOrder([...DEFAULT_METADATA_COLUMN_ORDER]);
    setMetadataColumnsPopupOpen(false);
    setMetadataFiltersPopupOpen(false);
    setMetadataExportPopupOpen(false);
    setMetadataExportColumns({});
    setMetadataExportOrder([]);
    setMetadataNotes({});
    setOverviewByCryo(createCryoStateArray(() => createOverviewState()));
    setOverviewSelectionByCryo(createCryoStateArray(() => createOverviewSelection()));
    setOverviewCropByCryo(createCryoStateArray(() => ({ rectPx: null, cuts: [], layer: 'pre' })));
    setOverviewContoursByCryo(createCryoStateArray(() => []));
    setActiveOverviewContourByCryo(createCryoStateArray(() => null));
    setOverviewContourPreviewByCryo(createCryoStateArray(() => null));
    setOverviewExportByCryo(createCryoStateArray(() => null));
    overviewHistoryRef.current = createCryoStateArray(() => []);
    setSelectedPlateCells(new Set());
    setActiveTab('project');
    setLastSavedSnapshot('');
    setHasUnsavedChanges(true);
    setProjectHistory([]);
    if (sessionUsers.length > 0) {
      startSession([], sessionUsers);
    } else {
      setSessions([]);
      setCurrentSessionId(null);
      setSelectedSessionId(null);
    }
  };

  const handleLoadProject = async (usersOverride?: string[], filePathOverride?: string) => {
    const directPath = filePathOverride ?? pendingLoadPathRef.current ?? undefined;
    if (!usersOverride && !ensureUser('load', directPath)) {
      return;
    }
    pendingLoadPathRef.current = null;
    const sessionUsers = normalizeUserList(usersOverride ?? selectedSessionUsers);
    setDetachCryoPromptOpen(false);
    if (!window.lifApi?.loadProject || !window.lifApi?.loadProjectFromPath) {
      setStatus('Load not available.');
      return;
    }
    const response: LmdLoadResponse = directPath
      ? await window.lifApi.loadProjectFromPath(directPath)
      : await window.lifApi.loadProject();
    if ('error' in response) {
      setStatus(response.error);
      return;
    }
    if ('canceled' in response) {
      return;
    }

    const data = response.data ?? {};
    const record = data as Record<string, unknown>;
    const loadedVersion = typeof record.version === 'string' ? record.version : '';
    const projectRecord =
      record.project && typeof record.project === 'object'
        ? (record.project as Record<string, unknown>)
        : {};
    const loadedSessions = normalizeSessions(record.sessions, new Date().toISOString());
    const loadedHistory = normalizeHistory(record.history);
    setProjectHistory(loadedHistory);
    if (sessionUsers.length > 0) {
      const session = createSession(sessionUsers);
      setSessions([...loadedSessions, session]);
      setCurrentSessionId(session.id);
      setSelectedSessionId(session.id);
    } else {
      setSessions(loadedSessions);
      setCurrentSessionId(null);
      setSelectedSessionId(
        loadedSessions.length ? loadedSessions[loadedSessions.length - 1].id : null
      );
    }

    setProjectName(
      typeof projectRecord.name === 'string' ? projectRecord.name : 'New session'
    );
    const loadedProjectType =
      projectRecord.type === 'Split-plate two cryosections' ||
      projectRecord.type === 'One plate two cryosections' ||
      projectRecord.type === 'One plate one cryosection' ||
      projectRecord.type === 'Flexible multi-cryosection'
        ? (projectRecord.type as ProjectType)
        : 'Split-plate two cryosections';
    setProjectDescription(
      typeof projectRecord.description === 'string' ? projectRecord.description : ''
    );
    const normalizeStage = (value: unknown): number | null => {
      const numeric = typeof value === 'number' ? value : Number(value);
      return [1, 2, 3, 4].includes(numeric) ? numeric : null;
    };
    const normalizeStartNumber = (value: unknown): number => {
      const numeric =
        typeof value === 'number'
          ? value
          : Number.parseInt(String(value ?? '').replace(/\D/g, ''), 10);
      if (!Number.isFinite(numeric) || numeric < 1) {
        return DEFAULT_MICROSAMPLE_START;
      }
      return Math.floor(numeric);
    };
    const nextCryosectionCount =
      projectRecord.cryosectionCount !== undefined
        ? normalizeCryosectionCount(projectRecord.cryosectionCount)
        : loadedProjectType === 'One plate one cryosection'
          ? 1
          : 2;
    const nextPlateCount =
      projectRecord.plateCount !== undefined
        ? normalizePlateCount(projectRecord.plateCount)
        : loadedProjectType === 'Split-plate two cryosections'
          ? 2
          : 1;
    const nextCryosections = createCryosectionConfigs();
    const savedCryosections = Array.isArray(projectRecord.cryosections)
      ? projectRecord.cryosections
      : [];
    if (savedCryosections.length > 0) {
      for (let index = 0; index < Math.min(savedCryosections.length, MAX_CRYOSECTIONS); index += 1) {
        const entry =
          savedCryosections[index] && typeof savedCryosections[index] === 'object'
            ? (savedCryosections[index] as Record<string, unknown>)
            : {};
        nextCryosections[index] = {
          name: typeof entry.name === 'string' ? entry.name : '',
          color: normalizeCryosectionColor(entry.color, index),
          stagePosition: normalizeStage(entry.stagePosition) ?? DEFAULT_STAGE_POSITION
        };
      }
    } else {
      const nextStagePositions: [number | null, number | null] = Array.isArray(projectRecord.stagePositions)
        ? [
            normalizeStage(projectRecord.stagePositions[0]) ?? DEFAULT_STAGE_POSITION,
            normalizeStage(projectRecord.stagePositions[1]) ?? DEFAULT_STAGE_POSITION
          ]
        : [
            normalizeStage(projectRecord.stagePosition) ?? DEFAULT_STAGE_POSITION,
            DEFAULT_STAGE_POSITION
          ];
      nextCryosections[0] = {
        name:
          typeof projectRecord.cryosection1 === 'string' ? projectRecord.cryosection1 : '',
        color: getDefaultCryosectionColor(0),
        stagePosition: nextStagePositions[0]
      };
      nextCryosections[1] = {
        name:
          typeof projectRecord.cryosection2 === 'string' ? projectRecord.cryosection2 : '',
        color: getDefaultCryosectionColor(1),
        stagePosition: nextStagePositions[1]
      };
    }
    setCryosectionCount(nextCryosectionCount);
    setCryosections(nextCryosections);
    setPlateCount(nextPlateCount);
    setActiveCryosection(0);
    setCoordinateFrameMode('images');

    const cryoRecords = Array.isArray(record.cryosectionData)
      ? record.cryosectionData
      : Array.isArray(record.cryosections)
        ? record.cryosections
        : [];
    const lifFilesByRecord = createCryoStateArray(() => [] as string[]);
    const csvFilesByRecord = createCryoStateArray(() => [] as string[]);
    const csvSourceGroupIdsByRecord = createCryoStateArray(() => null as string | null);
    const csvPlatesByRecord = createCryoStateArray(() => [createCsvCells(), createCsvCells()]);
    const csvPlacementsByRecord = createCryoStateArray(() => [] as CsvPlacement[]);
    const hasCsvRaw = createCryoStateArray(() => false);

    if (cryoRecords.length) {
      for (let index = 0; index < Math.min(cryoRecords.length, MAX_CRYOSECTIONS); index += 1) {
        const entry =
          cryoRecords[index] && typeof cryoRecords[index] === 'object'
            ? (cryoRecords[index] as Record<string, unknown>)
            : {};
        lifFilesByRecord[index] = Array.isArray(entry.lifFiles)
          ? entry.lifFiles.filter((item): item is string => typeof item === 'string')
          : [];
        csvFilesByRecord[index] = Array.isArray(entry.csvFiles)
          ? entry.csvFiles.filter((item): item is string => typeof item === 'string')
          : [];
        csvSourceGroupIdsByRecord[index] = normalizeCsvSourceGroupId(entry.csvSourceGroupId);
        const raw = Array.isArray(entry.csvPlates) ? entry.csvPlates : [];
        if (raw.length) {
          hasCsvRaw[index] = true;
          csvPlatesByRecord[index] = [normalizeCsvData(raw[0]), normalizeCsvData(raw[1])];
        }
        const placementsRaw = Array.isArray(entry.csvPlacements) ? entry.csvPlacements : [];
        csvPlacementsByRecord[index] = placementsRaw.length
          ? normalizeCsvPlacements(placementsRaw)
          : flattenCsvPlacementsFromPlates(csvPlatesByRecord[index]);
      }
    } else {
      const legacyFiles = Array.isArray(record.projectFiles)
        ? record.projectFiles.filter((item): item is string => typeof item === 'string')
        : [];
      const legacyCsv = Array.isArray(record.csvFiles)
        ? record.csvFiles.filter((item): item is string => typeof item === 'string')
        : [];
      lifFilesByRecord[0] = legacyFiles;
      csvFilesByRecord[0] = legacyCsv;
      const csvRaw = Array.isArray(record.csvPlates) ? record.csvPlates : [];
      if (csvRaw.length) {
        hasCsvRaw[0] = true;
        csvPlatesByRecord[0] = [normalizeCsvData(csvRaw[0]), normalizeCsvData(csvRaw[1])];
      }
      csvPlacementsByRecord[0] = flattenCsvPlacementsFromPlates(csvPlatesByRecord[0]);
    }
    const nextCsvSourceGroupIdsByRecord = reconcileCsvSourceGroupIds(
      csvFilesByRecord,
      csvSourceGroupIdsByRecord
    );

    const legacyPositiveStarts: [number, number] = Array.isArray(projectRecord.cryosectionStartNumbers)
      ? [
          normalizeStartNumber(projectRecord.cryosectionStartNumbers[0]),
          normalizeStartNumber(projectRecord.cryosectionStartNumbers[1])
        ]
      : [
          normalizeStartNumber(projectRecord.cryosectionStart1),
          normalizeStartNumber(projectRecord.cryosectionStart2)
        ];
    const legacyNegativeStarts: [number, number] = Array.isArray(projectRecord.cryosectionNegativeStartNumbers)
      ? [
          normalizeStartNumber(projectRecord.cryosectionNegativeStartNumbers[0]),
          normalizeStartNumber(projectRecord.cryosectionNegativeStartNumbers[1])
        ]
      : [
          projectRecord.cryosectionNegativeStart1 !== undefined
            ? normalizeStartNumber(projectRecord.cryosectionNegativeStart1)
            : legacyPositiveStarts[0],
          projectRecord.cryosectionNegativeStart2 !== undefined
            ? normalizeStartNumber(projectRecord.cryosectionNegativeStart2)
            : legacyPositiveStarts[1]
        ];
    const nextPlateAssignments = (() => {
      const normalizeSegment = (raw: unknown): PlateSegmentAssignment => {
        const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const parsedCryoIndex =
          record.cryoIndex === null || record.cryoIndex === undefined
            ? null
            : Number.parseInt(String(record.cryoIndex), 10);
        return {
          cryoIndex:
            Number.isFinite(parsedCryoIndex) &&
            parsedCryoIndex >= 0 &&
            parsedCryoIndex < MAX_CRYOSECTIONS
              ? parsedCryoIndex
              : null,
          positiveStart: normalizeStartNumber(record.positiveStart),
          positiveManual:
            typeof record.positiveManual === 'boolean' ? record.positiveManual : true,
          negativeStart: normalizeStartNumber(record.negativeStart),
          negativeManual:
            typeof record.negativeManual === 'boolean' ? record.negativeManual : true
        };
      };
      if (Array.isArray(projectRecord.plateAssignments)) {
        return Array.from({ length: MAX_PLATES }, (_, plateIndex) => {
          const rawPlate =
            projectRecord.plateAssignments[plateIndex] &&
            typeof projectRecord.plateAssignments[plateIndex] === 'object'
              ? (projectRecord.plateAssignments[plateIndex] as Record<string, unknown>)
              : {};
          const segmentsRaw = Array.isArray(rawPlate.segments) ? rawPlate.segments : [];
          return {
            split: rawPlate.split === true,
            segments: [
              normalizeSegment(segmentsRaw[0]),
              normalizeSegment(segmentsRaw[1])
            ] as [PlateSegmentAssignment, PlateSegmentAssignment]
          };
        });
      }
      if (loadedProjectType === 'One plate one cryosection') {
        return [
          {
            split: false,
            segments: [
              {
                cryoIndex: 0,
                positiveStart: legacyPositiveStarts[0],
                positiveManual: true,
                negativeStart: legacyNegativeStarts[0],
                negativeManual: true
              },
              createPlateSegmentAssignment(null)
            ]
          },
          {
            split: false,
            segments: [createPlateSegmentAssignment(null), createPlateSegmentAssignment(null)]
          }
        ];
      }
      return [
        {
          split: true,
          segments: [
            {
              cryoIndex: 0,
              positiveStart: legacyPositiveStarts[0],
              positiveManual: true,
              negativeStart: legacyNegativeStarts[0],
              negativeManual: true
            },
            {
              cryoIndex: 1,
              positiveStart: legacyPositiveStarts[1],
              positiveManual: true,
              negativeStart: legacyNegativeStarts[1],
              negativeManual: true
            }
          ]
        },
        {
          split: loadedProjectType === 'Split-plate two cryosections',
          segments: [
            {
              cryoIndex: loadedProjectType === 'Split-plate two cryosections' ? 0 : null,
              positiveStart: legacyPositiveStarts[0],
              positiveManual: true,
              negativeStart: legacyNegativeStarts[0],
              negativeManual: true
            },
            {
              cryoIndex: loadedProjectType === 'Split-plate two cryosections' ? 1 : null,
              positiveStart: legacyPositiveStarts[1],
              positiveManual: true,
              negativeStart: legacyNegativeStarts[1],
              negativeManual: true
            }
          ]
        }
      ];
    })();
    setPlateAssignments(nextPlateAssignments);

    const sharedCsvRepairFlags = createCryoStateArray(() => false);
    if (!loadedVersion || isVersionAtMost(loadedVersion, '1.2.1')) {
      const cryosBySource = new Map<string, number[]>();
      for (let cryoIndex = 0; cryoIndex < MAX_CRYOSECTIONS; cryoIndex += 1) {
        if ((csvFilesByRecord[cryoIndex]?.length ?? 0) === 0) {
          continue;
        }
        const sourceKey = buildSharedCsvSourceKey(
          csvFilesByRecord[cryoIndex] ?? [],
          cryoIndex,
          nextCsvSourceGroupIdsByRecord[cryoIndex]
        );
        const existing = cryosBySource.get(sourceKey) ?? [];
        existing.push(cryoIndex);
        cryosBySource.set(sourceKey, existing);
      }
      for (const cryoIndexes of cryosBySource.values()) {
        if (cryoIndexes.length < 2) {
          continue;
        }
        const hasProtectedMappings = cryoIndexes.some((cryoIndex) =>
          csvPlatesContainManualOrDerivedLinks(csvPlatesByRecord[cryoIndex] ?? [createCsvCells(), createCsvCells()])
        );
        if (hasProtectedMappings) {
          continue;
        }
        for (const cryoIndex of cryoIndexes) {
          sharedCsvRepairFlags[cryoIndex] = true;
        }
      }
    }

    setCsvFilesByCryo(csvFilesByRecord);
    setCsvSourceGroupIdsByCryo(nextCsvSourceGroupIdsByRecord);
    setLifFilesByCryo(lifFilesByRecord);
    setCsvPlatesByCryo(csvPlatesByRecord);
    setCsvPlacementsByCryo(csvPlacementsByRecord);
    manualPointUndoStackRef.current = [];

    const platesRaw = Array.isArray(record.designPlates) ? record.designPlates : [];
    const normalizedPlates = [
      normalizePlateData(platesRaw[0], formatPlateDisplayLabel(0, '')),
      normalizePlateData(platesRaw[1], formatPlateDisplayLabel(1, ''))
    ];
    const nextPlateBatchIds: [string, string] = Array.isArray(projectRecord.plateBatchIds)
      ? [
          typeof projectRecord.plateBatchIds[0] === 'string'
            ? projectRecord.plateBatchIds[0]
            : '',
          typeof projectRecord.plateBatchIds[1] === 'string'
            ? projectRecord.plateBatchIds[1]
            : ''
        ]
      : [
          extractPlateBatchId(normalizedPlates[0]?.label, 0),
          extractPlateBatchId(normalizedPlates[1]?.label, 1)
        ];
    setPlateBatchIds(nextPlateBatchIds);
    setDesignPlates(
      normalizedPlates.map((plate, plateIndex) => ({
        ...plate,
        label: formatPlateDisplayLabel(plateIndex, nextPlateBatchIds[plateIndex] ?? '')
      }))
    );
    setCollapsedPlates([true, true]);

    setSelectedProjectSegment({ plateIndex: 0, segmentIndex: 0 });

    const collectionRaw = Array.isArray(record.collectionPlates) ? record.collectionPlates : [];
    setCollectionPlates([
      normalizeCollectionData(collectionRaw[0]),
      normalizeCollectionData(collectionRaw[1])
    ]);
    const collectionNotesRaw = Array.isArray(record.collectionPlateNotes)
      ? record.collectionPlateNotes
      : [];
    setCollectionPlateNotes([
      typeof collectionNotesRaw[0] === 'string'
        ? collectionNotesRaw[0]
        : normalizedPlates[0]?.notes ?? '',
      typeof collectionNotesRaw[1] === 'string'
        ? collectionNotesRaw[1]
        : normalizedPlates[1]?.notes ?? ''
    ]);
    setCollectionColumnAreas(
      normalizeCollectionColumnAreas(record.collectionColumnAreas)
    );
    setCollectionColumnWarning(null);
    const collectionMetadataRaw =
      record.collectionMetadata && typeof record.collectionMetadata === 'object'
        ? (record.collectionMetadata as Record<string, unknown>)
        : {};
    const savedCollectionEncodingMode =
      collectionMetadataRaw.encodingMode === 'legacy' ||
      collectionMetadataRaw.encodingMode === 'corrected'
        ? (collectionMetadataRaw.encodingMode as CollectionEncodingMode)
        : null;
    const shouldPromptLegacyCollectionFix =
      !savedCollectionEncodingMode &&
      (!loadedVersion || isVersionAtMost(loadedVersion, '1.0.3'));
    const loadedCollectionEncodingMode: CollectionEncodingMode =
      savedCollectionEncodingMode ?? (shouldPromptLegacyCollectionFix ? 'legacy' : 'corrected');
    setCollectionMetadata({
      collectionMethod:
        typeof collectionMetadataRaw.collectionMethod === 'string' &&
        COLLECTION_METHOD_OPTIONS.includes(collectionMetadataRaw.collectionMethod)
          ? collectionMetadataRaw.collectionMethod
          : COLLECTION_METHOD_OPTIONS[0],
      encodingMode: loadedCollectionEncodingMode,
      date:
        typeof collectionMetadataRaw.date === 'string' ? collectionMetadataRaw.date : '',
      temperature:
        typeof collectionMetadataRaw.temperature === 'string'
          ? collectionMetadataRaw.temperature
          : '',
      humidity:
        typeof collectionMetadataRaw.humidity === 'string'
          ? collectionMetadataRaw.humidity
          : '',
      notes:
        typeof collectionMetadataRaw.notes === 'string' ? collectionMetadataRaw.notes : '',
      startTime:
        typeof collectionMetadataRaw.startTime === 'string'
          ? collectionMetadataRaw.startTime
          : '',
      endTime:
        typeof collectionMetadataRaw.endTime === 'string'
          ? collectionMetadataRaw.endTime
          : '',
      startTimeManual:
        collectionMetadataRaw.startTimeManual === true,
      endTimeManual:
        collectionMetadataRaw.endTimeManual === true
    });
    setLegacyCollectionPrompt(
      shouldPromptLegacyCollectionFix ? { version: loadedVersion || '1.0.3' } : null
    );

    const filters =
      record.metadataFilters && typeof record.metadataFilters === 'object'
        ? (record.metadataFilters as Record<string, unknown>)
        : {};
    setMetadataSearch(typeof filters.search === 'string' ? filters.search : '');
    const searchColumnRaw = typeof filters.searchColumn === 'string' ? filters.searchColumn : 'all';
    const isValidSearchColumn =
      searchColumnRaw === 'all' ||
      METADATA_COLUMNS.some((column) => column.key === searchColumnRaw) ||
      isContourNameColumnKey(searchColumnRaw);
    setMetadataSearchScope(isValidSearchColumn ? (searchColumnRaw as MetadataSearchScope) : 'all');
    setMetadataPlate1(filters.plate1 !== false);
    setMetadataPlate2(filters.plate2 !== false);
    const cryoFiltersRaw = Array.isArray(filters.cryoFilters) ? filters.cryoFilters : [];
    setMetadataCryoFilters(
      createCryoStateArray((index) =>
        typeof cryoFiltersRaw[index] === 'boolean'
          ? (cryoFiltersRaw[index] as boolean)
          : index === 0
            ? filters.halfLeft !== false
            : index === 1
              ? filters.halfRight !== false
              : true
      )
    );
    setMetadataP(filters.sampleP !== false);
    setMetadataM(filters.sampleM !== false);
    setMetadataZ(filters.sampleZ !== false);
    setMetadataR(filters.sampleR !== false);
    setMetadataN(filters.sampleN !== false);
    const columnsRaw =
      filters.columns && typeof filters.columns === 'object'
        ? (filters.columns as Record<string, unknown>)
        : {};
    const nextColumns = { ...DEFAULT_METADATA_COLUMNS };
    for (const column of METADATA_COLUMNS) {
      if (typeof columnsRaw[column.key] === 'boolean') {
        nextColumns[column.key] = columnsRaw[column.key] as boolean;
      }
    }
    const columnOrderRaw = Array.isArray(filters.columnOrder) ? filters.columnOrder : [];
    const nextColumnOrder = [
      ...columnOrderRaw.filter((value): value is string => typeof value === 'string'),
      ...DEFAULT_METADATA_COLUMN_ORDER
    ].filter((value, index, array) => array.indexOf(value) === index);
    setMetadataColumns(nextColumns);
    setMetadataColumnOrder(nextColumnOrder);
    setMetadataColumnsPopupOpen(false);
    setMetadataFiltersPopupOpen(false);
    setMetadataExportPopupOpen(false);
    setMetadataExportColumns({});
    setMetadataExportOrder([]);

    const viewRaw =
      record.viewSettings && typeof record.viewSettings === 'object'
        ? (record.viewSettings as Record<string, unknown>)
        : {};
    const opacityValue = Number(viewRaw.imageOpacity);
    setImageOpacity(Number.isFinite(opacityValue) ? Math.max(0, Math.min(1, opacityValue)) : 1);
    const micronValue = Number(viewRaw.micronsPerPixel);
    setMicronsPerPixel(
      Number.isFinite(micronValue) && micronValue > 0 ? micronValue : DEFAULT_MICRONS_PER_PIXEL
    );
    setShowCutPoints(viewRaw.showCutPoints !== false);
    setShowCutLabels(viewRaw.showCutLabels === true);
    setShowCoordinateOrphanPreImages(viewRaw.showCoordinateOrphanPreImages !== false);
    setShowCoordinateOrphanPostImages(viewRaw.showCoordinateOrphanPostImages !== false);
    setCoordinateOrphanCollectorFilter(
      typeof viewRaw.coordinateOrphanCollectorFilter === 'string' &&
        (viewRaw.coordinateOrphanCollectorFilter === 'all' ||
          PLATE_ROWS.includes(viewRaw.coordinateOrphanCollectorFilter))
        ? viewRaw.coordinateOrphanCollectorFilter
        : 'all'
    );
    setFilterPre(viewRaw.filterPre !== false);
    setFilterPost(viewRaw.filterPost !== false);
    const viewLocks = Array.isArray(viewRaw.collectionPlateLocks)
      ? viewRaw.collectionPlateLocks
      : [];
    const legacyLocks = Array.isArray(filters.lockPlates) ? filters.lockPlates : [];
    const fallbackLocks: [boolean, boolean] = [
      filters.lockPlate1 === true,
      filters.lockPlate2 === true
    ];
    setCollectionPlateLocks([
      typeof viewLocks[0] === 'boolean'
        ? viewLocks[0]
        : typeof legacyLocks[0] === 'boolean'
          ? legacyLocks[0]
          : fallbackLocks[0],
      typeof viewLocks[1] === 'boolean'
        ? viewLocks[1]
        : typeof legacyLocks[1] === 'boolean'
          ? legacyLocks[1]
          : fallbackLocks[1]
    ]);
    const randomRaw =
      viewRaw.randomAssignmentSettings && typeof viewRaw.randomAssignmentSettings === 'object'
        ? (viewRaw.randomAssignmentSettings as Record<string, unknown>)
        : {};
    const toControlCount = (value: unknown, fallback = 2): number => {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) {
        return fallback;
      }
      return Math.floor(numeric);
    };
    const toMaxControlsPerColumn = (value: unknown, fallback = 1): number => {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric) || numeric < 1) {
        return fallback;
      }
      return Math.max(1, Math.min(8, Math.floor(numeric)));
    };
    setRandomAssignmentSettings({
      M: toControlCount(randomRaw.M, 2),
      Z: toControlCount(randomRaw.Z, 2),
      R: toControlCount(randomRaw.R, 2),
      maxControlsPerColumn: toMaxControlsPerColumn(randomRaw.maxControlsPerColumn, 1),
      sustainabilityMode: randomRaw.sustainabilityMode !== false
    });

    const cutVisRaw = Array.isArray(record.cutPointVisibility) ? record.cutPointVisibility : [];
    setCutPointVisibilityByCryo(
      createCryoStateArray((index) =>
        typeof cutVisRaw[index] === 'object' && cutVisRaw[index]
          ? (cutVisRaw[index] as Record<string, { point: boolean; image: boolean }>)
          : {}
      )
    );

    const orphanVisRaw = Array.isArray(record.orphanImageVisibility)
      ? record.orphanImageVisibility
      : [];
    setOrphanImageVisibilityByCryo(
      createCryoStateArray((index) =>
        typeof orphanVisRaw[index] === 'object' && orphanVisRaw[index]
          ? (orphanVisRaw[index] as Record<string, boolean>)
          : {}
      )
    );

    const rawNotes =
      record.metadataNotes && typeof record.metadataNotes === 'object'
        ? (record.metadataNotes as Record<string, unknown>)
        : {};
    const nextNotes: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawNotes)) {
      if (typeof value === 'string') {
        nextNotes[key] = value;
      }
    }
    setMetadataNotes(nextNotes);

    const overviewRaw = Array.isArray(record.overview) ? record.overview : [];
    const nextOverview = createCryoStateArray((index) =>
      normalizeOverviewState(overviewRaw[index])
    );
    setOverviewByCryo(nextOverview);
    void hydrateOverviewImages(nextOverview);
    overviewHistoryRef.current = createCryoStateArray(() => []);
    const overviewSelectionRaw = Array.isArray(record.overviewSelection)
      ? record.overviewSelection
      : [];
    setOverviewSelectionByCryo(
      createCryoStateArray((index) => normalizeOverviewSelection(overviewSelectionRaw[index]))
    );
    const overviewCropRaw = Array.isArray(record.overviewCrop) ? record.overviewCrop : [];
    setOverviewCropByCryo(
      createCryoStateArray((index) => normalizeOverviewCrop(overviewCropRaw[index]))
    );
    const overviewContoursRaw = Array.isArray(record.overviewContours)
      ? record.overviewContours
      : [];
    setOverviewContoursByCryo(
      createCryoStateArray((index) => normalizeOverviewContours(overviewContoursRaw[index]))
    );
    setActiveOverviewContourByCryo(createCryoStateArray(() => null));
    setOverviewContourPreviewByCryo(createCryoStateArray(() => null));
    const overviewExportRaw = Array.isArray(record.overviewExportSize)
      ? record.overviewExportSize
      : [];
    setOverviewExportByCryo(
      createCryoStateArray((index) => normalizeExportSize(overviewExportRaw[index]))
    );

    const rawCoordinateCache =
      record.coordinateCache && typeof record.coordinateCache === 'object'
        ? (record.coordinateCache as Record<string, unknown>)
        : {};
    const nextCoordinateCache: Record<string, { x: number; y: number }> = {};
    for (const [key, value] of Object.entries(rawCoordinateCache)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const x = typeof entry.x === 'number' ? entry.x : Number(entry.x);
      const y = typeof entry.y === 'number' ? entry.y : Number(entry.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        nextCoordinateCache[key] = { x, y };
      }
    }
    setCoordinateCache(nextCoordinateCache);
    const rawCoordinateOverrides = Array.isArray(record.coordinateOverrides)
      ? record.coordinateOverrides
      : [];
    const nextCoordinateOverrides = createCryoStateArray(() => ({} as Record<string, true>));
    for (let cryo = 0; cryo < MAX_CRYOSECTIONS; cryo += 1) {
      const source = rawCoordinateOverrides[cryo];
      if (!source || typeof source !== 'object') {
        continue;
      }
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        if (value === true) {
          nextCoordinateOverrides[cryo][key] = true;
        }
      }
    }
    setCoordinateOverridesByCryo(nextCoordinateOverrides);
    setCoordinatesReady(Object.keys(nextCoordinateCache).length > 0);

    setLastSavedPath(response.filePath);
    setLastSavedSnapshot('');
    setHasUnsavedChanges(true);
    setSyncSnapshotOnNext(false);
    setSelectedPlateCells(new Set());

    let sharedCsvRepairFailed = false;
    for (let cryoIndex = 0; cryoIndex < MAX_CRYOSECTIONS; cryoIndex += 1) {
      const shouldRepairSharedCsv = sharedCsvRepairFlags[cryoIndex] === true;
      if ((shouldRepairSharedCsv || !hasCsvRaw[cryoIndex]) && csvFilesByRecord[cryoIndex].length) {
        const loaded = await loadCsvFiles(csvFilesByRecord[cryoIndex], cryoIndex, {
          plateCount: nextPlateCount,
          assignments: nextPlateAssignments,
          csvFilesByCryo: csvFilesByRecord,
          csvSourceGroupIdsByCryo: nextCsvSourceGroupIdsByRecord
        });
        if (loaded === false && shouldRepairSharedCsv) {
          sharedCsvRepairFailed = true;
        }
      }
    }
    if (sharedCsvRepairFailed) {
      setErrorBanner(
        'This session was saved before shared CSV routing was fixed. The original CSV files could not be reopened, so the shared plate mappings could not be repaired automatically. Reimport or reuse the CSV files locally to rebuild them.'
      );
    }

    setElementsByCryo(createCryoStateArray(() => []));
    setSelectedIdByCryo(createCryoStateArray(() => null));
    setSelectedIdsByCryo(createCryoStateArray(() => new Set()));
    setLifFilesByCryo(createCryoStateArray(() => []));

    const hasAnyLif = lifFilesByRecord.some((files) => files.length > 0);
    if (hasAnyLif) {
      for (let cryoIndex = 0; cryoIndex < MAX_CRYOSECTIONS; cryoIndex += 1) {
        if (lifFilesByRecord[cryoIndex].length) {
          await loadLifFiles(lifFilesByRecord[cryoIndex], cryoIndex);
        }
      }
      setStatus(`Loaded session: ${response.filePath.split(/[\\\\/]/).pop()}`);
    } else {
      setStatus('Session loaded (no LIF files referenced).');
    }
  };
  saveProjectHandlerRef.current = handleSaveProject;
  loadProjectHandlerRef.current = handleLoadProject;
  newProjectHandlerRef.current = handleNewProject;

  const handleToggleSessionUser = (user: string, checked: boolean) => {
    setSelectedSessionUsers((prev) => {
      if (checked) {
        return normalizeUserList([...prev, user]);
      }
      return prev.filter((item) => item !== user);
    });
  };

  const handleAddUser = () => {
    const user = newUserInput.trim();
    if (!user) {
      return;
    }
    setAvailableUsers((prev) => normalizeUserList([...prev, user]));
    setSelectedSessionUsers((prev) => normalizeUserList([...prev, user]));
    setNewUserInput('');
  };

  const handleConfirmUser = () => {
    const users = normalizeUserList(selectedSessionUsers);
    if (!users.length) {
      return;
    }
    setUserPromptOpen(false);
    const action = pendingAction;
    setPendingAction(null);
    if (action === 'new') {
      handleNewProject(users);
      return;
    }
    if (action === 'load') {
      void handleLoadProject(users, pendingLoadPathRef.current ?? undefined);
      return;
    }
    pendingLoadPathRef.current = null;
    if (!currentSessionId) {
      startSession([], users);
    }
  };

  const handleConfirmClosePrompt = () => {
    const endTime = new Date().toISOString();
    const nextSessions = sessions.map((session) =>
      session.id === currentSessionId && !session.endTime
        ? { ...session, endTime, status: 'closed' }
        : session
    );
    setSessions(nextSessions);

    setClosePromptOpen(false);
    window.lifApi?.confirmClose?.();
  };

  const handleCancelClosePrompt = () => {
    setClosePromptOpen(false);
  };

  const projectSnapshot = useMemo(() => {
    return JSON.stringify(buildBasePayload());
  }, [buildBasePayload]);

  useEffect(() => {
    if (syncSnapshotOnNext) {
      setLastSavedSnapshot(projectSnapshot);
      setHasUnsavedChanges(false);
      setSyncSnapshotOnNext(false);
      return;
    }
    if (!lastSavedSnapshot) {
      setHasUnsavedChanges(true);
      return;
    }
    setHasUnsavedChanges(projectSnapshot !== lastSavedSnapshot);
  }, [projectSnapshot, lastSavedSnapshot, syncSnapshotOnNext]);

  const applySampleType = (type: SampleType) => {
    if (designLocked) {
      return;
    }
    if (selectedPlateCells.size === 0) {
      return;
    }
    const selectionByPlate = new Map<number, Array<[number, number]>>();
    for (const key of selectedPlateCells) {
      const [plateIndex, rowIndex, colIndex] = key.split(':').map(Number);
      if (!selectionByPlate.has(plateIndex)) {
        selectionByPlate.set(plateIndex, []);
      }
      selectionByPlate.get(plateIndex)?.push([rowIndex, colIndex]);
    }
    setDesignPlates((prev) =>
      prev.map((plate, plateIndex) => {
        if (plateIndex >= visiblePlateCount) {
          return plate;
        }
        const selections = selectionByPlate.get(plateIndex);
        if (!selections || selections.length === 0) {
          return plate;
        }
        const nextCells = plate.cells.map((row) => row.slice());
        for (const [rowIndex, colIndex] of selections) {
          if (nextCells[rowIndex]?.[colIndex] !== undefined) {
            nextCells[rowIndex][colIndex] = type;
          }
        }
        return { ...plate, cells: nextCells };
      })
    );
  };

  const shuffle = <T,>(items: T[]): T[] => {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  const updateRandomAssignmentCount = (type: 'M' | 'Z' | 'R', value: string) => {
    const digits = value.replace(/\D/g, '');
    const parsed = digits ? Number.parseInt(digits, 10) : 0;
    const normalized = Number.isFinite(parsed) ? Math.max(0, Math.min(48, parsed)) : 0;
    setRandomAssignmentSettings((prev) => ({ ...prev, [type]: normalized }));
  };

  const updateMaxControlsPerColumn = (value: string) => {
    const digits = value.replace(/\D/g, '');
    const parsed = digits ? Number.parseInt(digits, 10) : 1;
    const normalized = Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : 1;
    setRandomAssignmentSettings((prev) => ({ ...prev, maxControlsPerColumn: normalized }));
  };

  const randomAssignment = () => {
    if (designLocked) {
      return;
    }
    const mCount = Math.max(0, Math.floor(randomAssignmentSettings.M));
    const zCount = Math.max(0, Math.floor(randomAssignmentSettings.Z));
    const rCount = Math.max(0, Math.floor(randomAssignmentSettings.R));
    const maxControlsPerColumn = Math.max(
      1,
      Math.min(8, Math.floor(randomAssignmentSettings.maxControlsPerColumn))
    );
    const sustainability = randomAssignmentSettings.sustainabilityMode;
    setDesignPlates((prev) =>
      prev.map((plate, plateIndex) => {
        if (plateIndex >= visiblePlateCount) {
          return plate;
        }
        const nextCells = createPlateCells();
        const halfRanges = isPlateSplit(plateIndex)
          ? [
              { startCol: 0, endCol: 5 },
              { startCol: 6, endCol: 11 }
            ]
          : [{ startCol: 0, endCol: 11 }];
        const forcedRRow = sustainability
          ? Math.floor(Math.random() * PLATE_ROWS.length)
          : null;

        for (const range of halfRanges) {
          const positions: Array<[number, number]> = [];
          const controlsPerColumn = new Map<number, number>();
          for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
            for (let colIndex = range.startCol; colIndex <= range.endCol; colIndex += 1) {
              positions.push([rowIndex, colIndex]);
              if (!controlsPerColumn.has(colIndex)) {
                controlsPerColumn.set(colIndex, 0);
              }
            }
          }

          const canPlaceInColumn = (colIndex: number) =>
            (controlsPerColumn.get(colIndex) ?? 0) < maxControlsPerColumn;

          const takeAndAssign = (
            type: SampleType,
            count: number,
            poolBuilder: () => Array<[number, number]>
          ) => {
            let placed = 0;
            while (placed < count) {
              const pool = shuffle(
                poolBuilder().filter(
                  ([rowIndex, colIndex]) =>
                    nextCells[rowIndex][colIndex] === DEFAULT_SAMPLE && canPlaceInColumn(colIndex)
                )
              );
              const target = pool.pop();
              if (!target) {
                break;
              }
              const [rowIndex, colIndex] = target;
              nextCells[rowIndex][colIndex] = type;
              controlsPerColumn.set(colIndex, (controlsPerColumn.get(colIndex) ?? 0) + 1);
              placed += 1;
            }
          };

          if (sustainability && forcedRRow !== null) {
            takeAndAssign(
              'R',
              rCount,
              () => positions.filter(([rowIndex]) => rowIndex === forcedRRow)
            );
          } else {
            takeAndAssign('R', rCount, () => positions);
          }

          takeAndAssign('M', mCount, () => positions);
          takeAndAssign('Z', zCount, () => positions);
        }
        return { ...plate, cells: nextCells };
      })
    );
    setSelectedPlateCells(new Set());
  };

  const updateMap = useCallback(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0b1426';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let overlayMessage: string | null = null;
    let points: CoordinateImagePoint[] = [];

    if (!hasCoordinateInputs) {
      overlayMessage = 'Load LIF and CSV files to visualize coordinates.';
    } else {
      points = coordinateVisibleImagePoints;

      if (points.length === 0) {
        overlayMessage = 'No stage positions in this file.';
      }
    }

    const padding = 40 * (window.devicePixelRatio || 1);
    const imageBounds = points.map((point) => {
      const halfWidth =
        point.width && micronsPerPixel > 0 ? (point.width * micronsPerPixel) / 2 : 0;
      const halfHeight =
        point.height && micronsPerPixel > 0 ? (point.height * micronsPerPixel) / 2 : 0;
      return {
        minX: point.x - halfWidth,
        maxX: point.x + halfWidth,
        minY: point.y - halfHeight,
        maxY: point.y + halfHeight
      };
    });
    const cutPointBounds = visibleCoordinateCutPoints.map((point) => ({
      minX: point.x,
      maxX: point.x,
      minY: point.y,
      maxY: point.y
    }));
    const bounds =
      coordinateFrameMode === 'cut-points' && cutPointBounds.length > 0
        ? [expandStageBounds(
            {
              minX: Math.min(...cutPointBounds.map((entry) => entry.minX)),
              maxX: Math.max(...cutPointBounds.map((entry) => entry.maxX)),
              minY: Math.min(...cutPointBounds.map((entry) => entry.minY)),
              maxY: Math.max(...cutPointBounds.map((entry) => entry.maxY))
            },
            1000
          )]
        : imageBounds.length > 0
          ? imageBounds
          : [getDefaultViewerBounds(canvas.width, canvas.height, padding)];
    const minX = Math.min(...bounds.map((entry) => entry.minX));
    const maxX = Math.max(...bounds.map((entry) => entry.maxX));
    const minY = Math.min(...bounds.map((entry) => entry.minY));
    const maxY = Math.max(...bounds.map((entry) => entry.maxY));

    const spanX = Math.max(1e-9, maxX - minX);
    const spanY = Math.max(1e-9, maxY - minY);

    const prevBounds = mapBoundsRef.current;
    const boundsChanged =
      !prevBounds ||
      prevBounds.minX !== minX ||
      prevBounds.maxX !== maxX ||
      prevBounds.minY !== minY ||
      prevBounds.maxY !== maxY ||
      prevBounds.width !== canvas.width ||
      prevBounds.height !== canvas.height;

    let baseScale = mapTransformRef.current.baseScale;
    let baseOffsetX = mapTransformRef.current.baseOffsetX;
    let baseOffsetY = mapTransformRef.current.baseOffsetY;

    if (boundsChanged) {
      baseScale = Math.min(
        (canvas.width - padding * 2) / spanX,
        (canvas.height - padding * 2) / spanY
      );
      if (micronsPerPixel > 0) {
        baseScale = Math.min(baseScale, 1 / micronsPerPixel);
      }
      baseOffsetX = padding - minX * baseScale;
      baseOffsetY = padding - minY * baseScale;
      mapTransformRef.current = { baseScale, baseOffsetX, baseOffsetY, minX, minY };
      mapBoundsRef.current = {
        minX,
        maxX,
        minY,
        maxY,
        width: canvas.width,
        height: canvas.height
      };
    }

    const { zoom, panX, panY } = mapViewRef.current;
    const showThumbs = true;

    const stageMinX = ((0 - panX) / zoom - baseOffsetX) / baseScale;
    const stageMaxX = ((canvas.width - panX) / zoom - baseOffsetX) / baseScale;
    const stageMinY = ((0 - panY) / zoom - baseOffsetY) / baseScale;
    const stageMaxY = ((canvas.height - panY) / zoom - baseOffsetY) / baseScale;
    const stagePerPixel = 1 / (baseScale * zoom);
    const stageStep = niceStep(stagePerPixel * 120);
    const stepPx = stageStep * baseScale * zoom;
    const labelInterval = Math.max(1, Math.round(90 / Math.max(stepPx, 1)));

    const drawGridOverlay = () => {
      ctx.save();
      ctx.strokeStyle = 'rgba(148,163,184,0.16)';
      ctx.lineWidth = 1;
      ctx.font = `${Math.max(10, canvas.width * 0.011)}px "Source Code Pro", ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(226,232,240,0.75)';

      let xIndex = 0;
      const startX = Math.floor(stageMinX / stageStep) * stageStep;
      for (let x = startX; x <= stageMaxX; x += stageStep, xIndex += 1) {
        const sx = (x * baseScale + baseOffsetX) * zoom + panX;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, canvas.height);
        ctx.stroke();
        if (xIndex % labelInterval === 0) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(formatStageValue(x), sx, 6);
          ctx.textBaseline = 'bottom';
          ctx.fillText(formatStageValue(x), sx, canvas.height - 6);
        }
      }

      let yIndex = 0;
      const startY = Math.floor(stageMinY / stageStep) * stageStep;
      for (let y = startY; y <= stageMaxY; y += stageStep, yIndex += 1) {
        const sy = (y * baseScale + baseOffsetY) * zoom + panY;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(canvas.width, sy);
        ctx.stroke();
        if (yIndex % labelInterval === 0) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(formatStageValue(y), 6, sy);
          ctx.textAlign = 'right';
          ctx.fillText(formatStageValue(y), canvas.width - 6, sy);
        }
      }

      ctx.restore();
    };

    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padding, padding, canvas.width - padding * 2, canvas.height - padding * 2);

    mapPointsRef.current = [];
    mapOrphanImageRectsRef.current = [];
    const desiredThumbs = new Map<
      string,
      { size: number; elementId: string; sourceFile: string }
    >();

    for (const point of points) {
      const px = (point.x * baseScale + baseOffsetX) * zoom + panX;
      const py = (point.y * baseScale + baseOffsetY) * zoom + panY;
      const isActive = point.id === selectedId;
      const isSelected = selectedIds.has(point.id);

      const baseSize = 26;
      const size = Math.max(16, Math.min(1024, baseSize * zoom));
      const aspect = point.width && point.height ? point.height / point.width : 1;
      const physicalWidth =
        point.width && micronsPerPixel > 0 ? point.width * micronsPerPixel : undefined;
      const physicalHeight =
        point.height && micronsPerPixel > 0 ? point.height * micronsPerPixel : undefined;
      const drawW = physicalWidth ? physicalWidth * baseScale * zoom : size;
      const drawH = physicalHeight ? physicalHeight * baseScale * zoom : Math.max(14, size * aspect);

      const inView = px > -200 && px < canvas.width + 200 && py > -200 && py < canvas.height + 200;
      const thumbKey = `${point.sourceFile}::${point.elementId}`;
      if (inView && showThumbs && point.supported) {
        const desiredSize = Math.max(32, Math.min(1024, Math.ceil(Math.max(drawW, drawH))));
        desiredThumbs.set(thumbKey, {
          size: desiredSize,
          elementId: point.elementId,
          sourceFile: point.sourceFile
        });
      }

      const thumb = showThumbs ? thumbCacheRef.current.get(thumbKey) : undefined;
      if (thumb) {
        ctx.save();
        ctx.globalAlpha = imageOpacity;
        ctx.imageSmoothingEnabled = true;
        ctx.translate(px - drawW / 2, py - drawH / 2);
        ctx.drawImage(thumb.canvas, 0, 0, drawW, drawH);
        if (isSelected) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
          ctx.lineWidth = 2;
          ctx.strokeRect(0, 0, drawW, drawH);
        }
        if (isActive) {
          ctx.strokeStyle = '#f97316';
          ctx.lineWidth = 3;
          ctx.strokeRect(0, 0, drawW, drawH);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      } else if (showThumbs && point.supported) {
        ctx.save();
        ctx.globalAlpha = imageOpacity * 0.6;
        ctx.translate(px - drawW / 2, py - drawH / 2);
        ctx.fillStyle = 'rgba(148,163,184,0.18)';
        ctx.strokeStyle = 'rgba(148,163,184,0.35)';
        ctx.lineWidth = 1;
        ctx.fillRect(0, 0, drawW, drawH);
        ctx.strokeRect(0, 0, drawW, drawH);
        ctx.globalAlpha = 1;
        ctx.restore();
      } else {
        ctx.fillStyle = isActive ? '#f97316' : isSelected ? '#38bdf8' : '#cbd5f5';
        ctx.strokeStyle = 'rgba(15,23,42,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, isSelected ? 8 : 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      if (point.orphan) {
        mapOrphanImageRectsRef.current.push({
          id: point.id,
          name: point.name,
          x: px,
          y: py,
          w: drawW,
          h: drawH,
          imageWidth: point.width,
          imageHeight: point.height
        });
      }

    }

    if (showThumbs && desiredThumbs.size > 0) {
      let doneThumbs = 0;
      for (const [key, payload] of desiredThumbs.entries()) {
        const cached = thumbCacheRef.current.get(key);
        if (cached && cached.size >= payload.size) {
          doneThumbs += 1;
        }
      }
      setThumbProgress((prev) => {
        const next =
          doneThumbs < desiredThumbs.size
            ? { total: desiredThumbs.size, done: doneThumbs }
            : null;
        if (!next && !prev) {
          return prev;
        }
        if (next && prev && next.total === prev.total && next.done === prev.done) {
          return prev;
        }
        return next;
      });
      queueThumbnailLoadsRef.current(desiredThumbs);
    } else if (thumbProgress) {
      setThumbProgress(null);
    }

    drawGridOverlay();

    if (hoveredOrphanImageId) {
      const orphanRect = mapOrphanImageRectsRef.current.find((item) => item.id === hoveredOrphanImageId);
      if (orphanRect) {
        ctx.save();
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 3;
        ctx.strokeRect(
          orphanRect.x - orphanRect.w / 2,
          orphanRect.y - orphanRect.h / 2,
          orphanRect.w,
          orphanRect.h
        );
        ctx.restore();
      }
    }

    if (visibleCoordinateCutPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.lineWidth = 1;
      const radius = Math.max(2.6, Math.min(7.8, (2 + zoom) * 1.3));
      for (const point of visibleCoordinateCutPoints) {
        const px = (point.x * baseScale + baseOffsetX) * zoom + panX;
        const py = (point.y * baseScale + baseOffsetY) * zoom + panY;
        if (px < -20 || px > canvas.width + 20 || py < -20 || py > canvas.height + 20) {
          continue;
        }
        const isSelected = selectedCutIds.has(point.id);
        ctx.fillStyle = CUT_POINT_COLORS[point.sample] ?? '#facc15';
        ctx.beginPath();
        ctx.arc(px, py, isSelected ? radius * 1.4 : radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (isSelected) {
          ctx.strokeStyle = '#ec4899';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.arc(px, py, radius * 1.4 + 3, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.lineWidth = 1;
        }
        if (showCutLabels && point.code) {
          ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
          ctx.font = `${Math.max(10, Math.min(16, 9 + zoom * 1.4))}px "Source Code Pro", ui-monospace, monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(point.code, px + radius + 6, py);
        }
        mapPointsRef.current.push({
          id: point.id,
          x: px,
          y: py,
          w: (radius * 2) * 2,
          h: (radius * 2) * 2
        });
      }
      ctx.restore();
    }

    if (hoveredCutPointId) {
      const hovered = cutPointById.get(hoveredCutPointId);
      if (hovered) {
        const px = (hovered.x * baseScale + baseOffsetX) * zoom + panX;
        const py = (hovered.y * baseScale + baseOffsetY) * zoom + panY;
        ctx.save();
        const fontSize = Math.max(11, Math.min(15, 10 + zoom * 0.6));
        const fontFamily = '"Source Sans 3", sans-serif';
        const normalFont = `${fontSize}px ${fontFamily}`;
        const boldFont = `600 ${fontSize}px ${fontFamily}`;
        const paddingX = 8;
        const paddingY = 6;
        const lineHeight = Math.max(14, Math.min(18, 12 + zoom * 0.6));
        const line1 = [{ text: hovered.code || '—', bold: true }];
        const line2 = [
          { text: hovered.plateLabel || '—', bold: false },
          { text: ' · ', bold: false },
          { text: hovered.well ? formatWellDisplay(hovered.well) : '—', bold: true }
        ];
        const xValue = formatNumber(hovered.x, 2);
        const yValue = formatNumber(hovered.y, 2);
        const line3 = [
          { text: 'X:', bold: true },
          { text: ` ${xValue}`, bold: false },
          { text: ', ', bold: false },
          { text: 'Y:', bold: true },
          { text: ` ${yValue}`, bold: false }
        ];

        const measureLine = (segments: Array<{ text: string; bold: boolean }>) =>
          segments.reduce((total, segment) => {
            ctx.font = segment.bold ? boldFont : normalFont;
            return total + ctx.measureText(segment.text).width;
          }, 0);

        const maxWidth = Math.max(measureLine(line1), measureLine(line2), measureLine(line3));
        const boxWidth = maxWidth + paddingX * 2;
        const boxHeight = lineHeight * 3 + paddingY * 2;
        let boxX = px + 12;
        let boxY = py - boxHeight - 12;
        if (boxX + boxWidth > canvas.width - 8) {
          boxX = px - boxWidth - 12;
        }
        if (boxX < 8) {
          boxX = 8;
        }
        if (boxY < 8) {
          boxY = py + 12;
        }
        ctx.fillStyle = CUT_POINT_TOOLTIP_BG[hovered.sample] ?? 'rgba(15, 23, 42, 0.85)';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.6)';
        ctx.lineWidth = 1;
        const radiusPx = 8;
        ctx.beginPath();
        ctx.moveTo(boxX + radiusPx, boxY);
        ctx.lineTo(boxX + boxWidth - radiusPx, boxY);
        ctx.quadraticCurveTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + radiusPx);
        ctx.lineTo(boxX + boxWidth, boxY + boxHeight - radiusPx);
        ctx.quadraticCurveTo(
          boxX + boxWidth,
          boxY + boxHeight,
          boxX + boxWidth - radiusPx,
          boxY + boxHeight
        );
        ctx.lineTo(boxX + radiusPx, boxY + boxHeight);
        ctx.quadraticCurveTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - radiusPx);
        ctx.lineTo(boxX, boxY + radiusPx);
        ctx.quadraticCurveTo(boxX, boxY, boxX + radiusPx, boxY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const drawSegments = (
          segments: Array<{ text: string; bold: boolean; align?: 'left' | 'right' }>,
          y: number,
          maxLineWidth: number
        ) => {
          const leftSegments = segments.filter((segment) => segment.align !== 'right');
          const rightSegments = segments.filter((segment) => segment.align === 'right');
          let cursorX = boxX + paddingX;
          for (const segment of leftSegments) {
            ctx.font = segment.bold ? boldFont : normalFont;
            ctx.fillText(segment.text, cursorX, y);
            cursorX += ctx.measureText(segment.text).width;
          }
          if (rightSegments.length) {
            let rightWidth = 0;
            for (const segment of rightSegments) {
              ctx.font = segment.bold ? boldFont : normalFont;
              rightWidth += ctx.measureText(segment.text).width;
            }
            let rightX = boxX + paddingX + maxLineWidth - rightWidth;
            for (const segment of rightSegments) {
              ctx.font = segment.bold ? boldFont : normalFont;
              ctx.fillText(segment.text, rightX, y);
              rightX += ctx.measureText(segment.text).width;
            }
          }
        };
        drawSegments(line1, boxY + paddingY, maxWidth);
        drawSegments(line2, boxY + paddingY + lineHeight, maxWidth);
        drawSegments(line3, boxY + paddingY + lineHeight * 2, maxWidth);
        ctx.restore();
      }
    } else if (hoveredOrphanImageId) {
      const orphanInfo = orphanImageInfoById.get(hoveredOrphanImageId);
      const orphanRect = mapOrphanImageRectsRef.current.find((item) => item.id === hoveredOrphanImageId);
      if (orphanInfo && orphanRect) {
        ctx.save();
        const fontSize = 12;
        const paddingX = 10;
        const paddingY = 7;
        const line1 = orphanInfo.collector
          ? `${orphanInfo.name} · Collector ${orphanInfo.collector}`
          : orphanInfo.name;
        const hoverPosition = mapHoverPositionRef.current;
        const pixelX =
          hoverPosition && orphanRect.imageWidth
            ? Math.round(
                Math.max(
                  0,
                  Math.min(
                    orphanRect.imageWidth - 1,
                    ((hoverPosition.x - (orphanRect.x - orphanRect.w / 2)) / orphanRect.w) *
                      orphanRect.imageWidth
                  )
                )
              )
            : undefined;
        const pixelY =
          hoverPosition && orphanRect.imageHeight
            ? Math.round(
                Math.max(
                  0,
                  Math.min(
                    orphanRect.imageHeight - 1,
                    ((hoverPosition.y - (orphanRect.y - orphanRect.h / 2)) / orphanRect.h) *
                      orphanRect.imageHeight
                  )
                )
              )
            : undefined;
        const line2 =
          pixelX !== undefined && pixelY !== undefined ? `X: ${pixelX}, Y: ${pixelY}` : '';
        ctx.font = `500 ${fontSize}px "IBM Plex Sans", sans-serif`;
        const textWidth = Math.max(
          ctx.measureText(line1).width,
          line2 ? ctx.measureText(line2).width : 0
        );
        const boxWidth = textWidth + paddingX * 2;
        const lineHeight = fontSize + 4;
        const lineCount = line2 ? 2 : 1;
        const boxHeight = lineHeight * lineCount + paddingY * 2;
        let boxX = orphanRect.x + orphanRect.w / 2 + 12;
        let boxY = orphanRect.y - orphanRect.h / 2 - boxHeight - 12;
        if (boxX + boxWidth > canvas.width - 8) {
          boxX = orphanRect.x - orphanRect.w / 2 - boxWidth - 12;
        }
        if (boxX < 8) {
          boxX = 8;
        }
        if (boxY < 8) {
          boxY = orphanRect.y + orphanRect.h / 2 + 12;
        }
        ctx.fillStyle = 'rgba(249, 115, 22, 0.92)';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(line1, boxX + paddingX, boxY + paddingY);
        if (line2) {
          ctx.fillText(line2, boxX + paddingX, boxY + paddingY + lineHeight);
        }
        ctx.restore();
      }
    }

    if (
      mapHoverPositionRef.current &&
      !mapViewRef.current.isDragging &&
      !selectionRef.current.isSelecting
    ) {
      const hoverStage = mapCanvasToStage(mapHoverPositionRef.current.x, mapHoverPositionRef.current.y);
      const line = `X: ${formatNumber(hoverStage.x, 2)}  Y: ${formatNumber(hoverStage.y, 2)}`;
      ctx.save();
      ctx.font = `500 11px "IBM Plex Sans", sans-serif`;
      const paddingX = 8;
      const paddingY = 5;
      const boxWidth = ctx.measureText(line).width + paddingX * 2;
      const boxHeight = 22;
      let boxX = mapHoverPositionRef.current.x + 14;
      let boxY = mapHoverPositionRef.current.y + 14;
      if (boxX + boxWidth > canvas.width - 6) {
        boxX = mapHoverPositionRef.current.x - boxWidth - 14;
      }
      if (boxY + boxHeight > canvas.height - 6) {
        boxY = mapHoverPositionRef.current.y - boxHeight - 14;
      }
      boxX = Math.max(6, boxX);
      boxY = Math.max(6, boxY);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(line, boxX + paddingX, boxY + paddingY);
      ctx.restore();
    }

    if (overlayMessage) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = `${Math.max(12, canvas.width * 0.014)}px "Space Grotesk", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(overlayMessage, canvas.width / 2, canvas.height / 2);
      ctx.restore();
    }

    const selection = selectionRef.current;
    if (selection.isSelecting) {
      const left = Math.min(selection.startX, selection.endX);
      const top = Math.min(selection.startY, selection.endY);
      const width = Math.abs(selection.endX - selection.startX);
      const height = Math.abs(selection.endY - selection.startY);
      if (width > 1 && height > 1) {
        ctx.save();
        ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
        ctx.lineWidth = 1;
        ctx.fillRect(left, top, width, height);
        ctx.strokeRect(left, top, width, height);
        ctx.restore();
      }
    }
  }, [
    coordinateFrameMode,
    coordinateVisibleImagePoints,
    cutPointById,
    hasCoordinateInputs,
    hoveredCutPointId,
    hoveredOrphanImageId,
    selectedId,
    selectedIds,
    selectedCutIds,
    imageOpacity,
    micronsPerPixel,
    showCutLabels,
    orphanImageInfoById,
    thumbProgress,
    visibleCoordinateCutPoints
  ]);

  const updateOverview = useCallback(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0b1426';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const padding = 40 * (window.devicePixelRatio || 1);
    let overlayMessage: string | null = null;
    const stageSpec =
      stagePosition && STAGE_POSITIONS[stagePosition - 1]
        ? STAGE_POSITIONS[stagePosition - 1]
        : null;
    const slideBounds = stageSpec?.slide;
    const useDefaultBounds =
      !stageSpec ||
      (!hasCoordinateInputs &&
        !overview.pre.bitmap &&
        !overview.post.bitmap &&
        overviewCutPoints.length === 0 &&
        overviewContours.length === 0 &&
        !overviewContourPreview);
    let minX: number;
    let maxX: number;
    let minY: number;
    let maxY: number;
    if (useDefaultBounds) {
      const defaults = getDefaultViewerBounds(canvas.width, canvas.height, padding);
      minX = defaults.minX;
      maxX = defaults.maxX;
      minY = defaults.minY;
      maxY = defaults.maxY;
      if (!stageSpec) {
        overlayMessage = 'Select a stage position in Session to align the overview image.';
      }
    } else {
      minX = Math.min(slideBounds!.tl.x, slideBounds!.br.x);
      maxX = Math.max(slideBounds!.tl.x, slideBounds!.br.x);
      minY = Math.min(slideBounds!.tl.y, slideBounds!.br.y);
      maxY = Math.max(slideBounds!.tl.y, slideBounds!.br.y);

      if (overviewCutPoints.length > 0) {
        const xs = overviewCutPoints.map((point) => point.x);
        const ys = overviewCutPoints.map((point) => point.y);
        minX = Math.min(minX, ...xs);
        maxX = Math.max(maxX, ...xs);
        minY = Math.min(minY, ...ys);
        maxY = Math.max(maxY, ...ys);
      }
      for (const contour of overviewContours) {
        if (!contour.visible && contour.id !== activeOverviewContourId) {
          continue;
        }
        for (const point of contour.points) {
          minX = Math.min(minX, point.x);
          maxX = Math.max(maxX, point.x);
          minY = Math.min(minY, point.y);
          maxY = Math.max(maxY, point.y);
        }
      }
      if (activeOverviewContourId && overviewContourPreview) {
        minX = Math.min(minX, overviewContourPreview.x);
        maxX = Math.max(maxX, overviewContourPreview.x);
        minY = Math.min(minY, overviewContourPreview.y);
        maxY = Math.max(maxY, overviewContourPreview.y);
      }
    }

    const spanX = Math.max(1e-9, maxX - minX);
    const spanY = Math.max(1e-9, maxY - minY);

    const prevBounds = overviewBoundsRef.current;
    const boundsChanged =
      !prevBounds ||
      prevBounds.minX !== minX ||
      prevBounds.maxX !== maxX ||
      prevBounds.minY !== minY ||
      prevBounds.maxY !== maxY ||
      prevBounds.width !== canvas.width ||
      prevBounds.height !== canvas.height;

    let baseScale = overviewTransformRef.current.baseScale;
    let baseOffsetX = overviewTransformRef.current.baseOffsetX;
    let baseOffsetY = overviewTransformRef.current.baseOffsetY;

    if (boundsChanged) {
      baseScale = Math.min(
        (canvas.width - padding * 2) / spanX,
        (canvas.height - padding * 2) / spanY
      );
      baseOffsetX = padding - minX * baseScale;
      baseOffsetY = padding - minY * baseScale;
      overviewTransformRef.current = { baseScale, baseOffsetX, baseOffsetY, minX, minY };
      overviewBoundsRef.current = {
        minX,
        maxX,
        minY,
        maxY,
        width: canvas.width,
        height: canvas.height
      };
    }

    const { zoom, panX, panY } = overviewViewRef.current;
    const stageMinX = ((0 - panX) / zoom - baseOffsetX) / baseScale;
    const stageMaxX = ((canvas.width - panX) / zoom - baseOffsetX) / baseScale;
    const stageMinY = ((0 - panY) / zoom - baseOffsetY) / baseScale;
    const stageMaxY = ((canvas.height - panY) / zoom - baseOffsetY) / baseScale;
    const stagePerPixel = 1 / (baseScale * zoom);
    const stageStep = niceStep(stagePerPixel * 120);
    const stepPx = stageStep * baseScale * zoom;
    const labelInterval = Math.max(1, Math.round(90 / Math.max(stepPx, 1)));
    const stageToCanvas = (x: number, y: number) => ({
      x: (x * baseScale + baseOffsetX) * zoom + panX,
      y: (y * baseScale + baseOffsetY) * zoom + panY
    });

    const drawGridOverlay = () => {
      ctx.save();
      ctx.strokeStyle = 'rgba(148,163,184,0.16)';
      ctx.lineWidth = 1;
      ctx.font = `${Math.max(10, canvas.width * 0.011)}px "Source Code Pro", ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(226,232,240,0.75)';

      let xIndex = 0;
      const startX = Math.floor(stageMinX / stageStep) * stageStep;
      for (let x = startX; x <= stageMaxX; x += stageStep, xIndex += 1) {
        const sx = (x * baseScale + baseOffsetX) * zoom + panX;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, canvas.height);
        ctx.stroke();
        if (xIndex % labelInterval === 0) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(formatStageValue(x), sx, 6);
          ctx.textBaseline = 'bottom';
          ctx.fillText(formatStageValue(x), sx, canvas.height - 6);
        }
      }

      let yIndex = 0;
      const startY = Math.floor(stageMinY / stageStep) * stageStep;
      for (let y = startY; y <= stageMaxY; y += stageStep, yIndex += 1) {
        const sy = (y * baseScale + baseOffsetY) * zoom + panY;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(canvas.width, sy);
        ctx.stroke();
        if (yIndex % labelInterval === 0) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(formatStageValue(y), 6, sy);
          ctx.textAlign = 'right';
          ctx.fillText(formatStageValue(y), canvas.width - 6, sy);
        }
      }

      ctx.restore();
    };

    const drawLayer = (layer: OverviewLayerState, visible: boolean, isActive: boolean) => {
      if (!layer.bitmap || !visible || !slideBounds) {
        return;
      }
      const baseX = slideBounds.tl.x;
      const baseY = slideBounds.tl.y;
      const baseW = slideBounds.br.x - slideBounds.tl.x;
      const baseH = slideBounds.br.y - slideBounds.tl.y;
      const x = baseX + layer.offsetX;
      const y = baseY + layer.offsetY;
      const w = baseW * layer.scaleX;
      const h = baseH * layer.scaleY;
      const sx = (x * baseScale + baseOffsetX) * zoom + panX;
      const sy = (y * baseScale + baseOffsetY) * zoom + panY;
      const sw = w * baseScale * zoom;
      const sh = h * baseScale * zoom;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(layer.bitmap, sx, sy, sw, sh);
      if (isActive) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, sw, sh);
      }
      ctx.restore();
    };

    drawLayer(overview.pre, overview.showPre, overview.activeLayer === 'pre');
    drawLayer(overview.post, overview.showPost, overview.activeLayer === 'post');

    overviewPointsRef.current = [];

    if (overview.showCutImages || overview.showOrphanImages) {
      const desiredThumbs = new Map<
        string,
        { size: number; elementId: string; sourceFile: string }
      >();
      const requestedImageIds = new Set<string>();
      if (overview.showCutImages) {
        for (const id of overviewImageIds) {
          if (cutPointDisplay.visibleImageIds.has(id)) {
            requestedImageIds.add(id);
          }
        }
      }
      if (overview.showOrphanImages) {
        for (const id of orphanImageIds) {
          requestedImageIds.add(id);
        }
      }
      const filterByCutImages = requestedImageIds.size > 0;
      const visibleOverviewImages = new Set<string>();
      if (filterByCutImages) {
        for (const id of requestedImageIds) {
          visibleOverviewImages.add(id);
        }
      }
      const points = mapElements
        .filter((item) => item.stageX !== undefined && item.stageY !== undefined)
        .filter((item) => {
          if (!filterByCutImages) {
            return true;
          }
          return visibleOverviewImages.has(item.uiId);
        })
        .map((item) => ({
          id: item.uiId,
          elementId: item.id,
          sourceFile: item.sourceFile,
          x: item.stageX as number,
          y: item.stageY as number,
          supported: item.supported,
          orphan: orphanImageIds.has(item.uiId),
          width: item.width,
          height: item.height
        }));

      for (const point of points) {
        const px = (point.x * baseScale + baseOffsetX) * zoom + panX;
        const py = (point.y * baseScale + baseOffsetY) * zoom + panY;
        const baseSize = 26;
        const size = Math.max(16, Math.min(1024, baseSize * zoom));
        const aspect = point.width && point.height ? point.height / point.width : 1;
        const physicalWidth =
          point.width && micronsPerPixel > 0 ? point.width * micronsPerPixel : undefined;
        const physicalHeight =
          point.height && micronsPerPixel > 0 ? point.height * micronsPerPixel : undefined;
        const drawW = physicalWidth ? physicalWidth * baseScale * zoom : size;
        const drawH = physicalHeight
          ? physicalHeight * baseScale * zoom
          : Math.max(14, size * aspect);

        const inView =
          px > -200 && px < canvas.width + 200 && py > -200 && py < canvas.height + 200;
        const thumbKey = `${point.sourceFile}::${point.elementId}`;
        if (inView && point.supported) {
          const desiredSize = Math.max(32, Math.min(1024, Math.ceil(Math.max(drawW, drawH))));
          desiredThumbs.set(thumbKey, {
            size: desiredSize,
            elementId: point.elementId,
            sourceFile: point.sourceFile
          });
        }

        const thumb = thumbCacheRef.current.get(thumbKey);
        if (thumb) {
          ctx.save();
          ctx.globalAlpha = imageOpacity;
          ctx.imageSmoothingEnabled = true;
          ctx.translate(px - drawW / 2, py - drawH / 2);
          ctx.drawImage(thumb.canvas, 0, 0, drawW, drawH);
          if (point.orphan) {
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.95)';
            ctx.setLineDash([8, 5]);
            ctx.lineWidth = 2;
            ctx.strokeRect(0, 0, drawW, drawH);
            ctx.setLineDash([]);
          }
          ctx.globalAlpha = 1;
          ctx.restore();
          if (point.orphan) {
            ctx.save();
            ctx.font = `${Math.max(10, Math.min(14, 9 + zoom * 0.7))}px "Source Sans 3", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
            ctx.fillText('Orphan image', px, py - drawH / 2 - 4);
            ctx.restore();
          }
        }
      }

      if (desiredThumbs.size > 0) {
        queueThumbnailLoadsRef.current(desiredThumbs);
      }
    }

    drawGridOverlay();

    overviewContourAnchorsRef.current = [];
    if (overviewContours.length > 0) {
      ctx.save();
      for (const contour of overviewContours) {
        if (!contour.visible || contour.points.length === 0) {
          continue;
        }
        ctx.strokeStyle = contour.color;
        ctx.fillStyle = contour.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        contour.points.forEach((point, index) => {
          const canvasPoint = stageToCanvas(point.x, point.y);
          if (index === 0) {
            ctx.moveTo(canvasPoint.x, canvasPoint.y);
          } else {
            ctx.lineTo(canvasPoint.x, canvasPoint.y);
          }
        });
        if (contour.closed && contour.points.length > 2) {
          const first = stageToCanvas(contour.points[0].x, contour.points[0].y);
          ctx.lineTo(first.x, first.y);
        }
        if (contour.points.length > 1) {
          ctx.stroke();
        }
        for (const [pointIndex, point] of contour.points.entries()) {
          const canvasPoint = stageToCanvas(point.x, point.y);
          overviewContourAnchorsRef.current.push({
            contourId: contour.id,
            pointIndex,
            x: canvasPoint.x,
            y: canvasPoint.y
          });
          const isSelectedAnchor =
            activeOverviewContourAnchor?.contourId === contour.id &&
            activeOverviewContourAnchor.pointIndex === pointIndex;
          const isHoveredAnchor =
            hoveredOverviewContourAnchor?.contourId === contour.id &&
            hoveredOverviewContourAnchor.pointIndex === pointIndex;
          ctx.beginPath();
          ctx.arc(canvasPoint.x, canvasPoint.y, isSelectedAnchor || isHoveredAnchor ? 5 : 3, 0, Math.PI * 2);
          ctx.fill();
          if (isSelectedAnchor || isHoveredAnchor) {
            ctx.strokeStyle = isSelectedAnchor ? '#f9a8d4' : 'rgba(125, 211, 252, 0.95)';
            ctx.lineWidth = isSelectedAnchor ? 2 : 1.5;
            ctx.beginPath();
            ctx.arc(canvasPoint.x, canvasPoint.y, isSelectedAnchor ? 7 : 6.5, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        if (overviewContourInsertPreview?.contourId === contour.id) {
          const previewPoint = stageToCanvas(
            overviewContourInsertPreview.x,
            overviewContourInsertPreview.y
          );
          ctx.save();
          ctx.fillStyle = 'rgba(125, 211, 252, 0.5)';
          ctx.strokeStyle = 'rgba(125, 211, 252, 0.9)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(previewPoint.x, previewPoint.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(previewPoint.x - 4, previewPoint.y);
          ctx.lineTo(previewPoint.x + 4, previewPoint.y);
          ctx.moveTo(previewPoint.x, previewPoint.y - 4);
          ctx.lineTo(previewPoint.x, previewPoint.y + 4);
          ctx.stroke();
          ctx.restore();
        }
        if (contour.points.length > 0) {
          const anchor = stageToCanvas(contour.points[0].x, contour.points[0].y);
          ctx.font = `${Math.max(10, canvas.width * 0.009)}px "Source Sans 3", sans-serif`;
          ctx.fillStyle = '#e5e7eb';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(contour.name, anchor.x + 6, anchor.y - 6);
        }
      }
      const drawingContour = activeOverviewContourId
        ? overviewContours.find((contour) => contour.id === activeOverviewContourId)
        : undefined;
      if (drawingContour && overviewContourPreview && drawingContour.points.length > 0) {
        const last = drawingContour.points[drawingContour.points.length - 1];
        const from = stageToCanvas(last.x, last.y);
        const to = stageToCanvas(overviewContourPreview.x, overviewContourPreview.y);
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = drawingContour.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    if (overviewSelection.rect && (overviewSelection.rect.w !== 0 || overviewSelection.rect.h !== 0)) {
      const rectStage = normalizeRect(overviewSelection.rect);
      const sx = (rectStage.x * baseScale + baseOffsetX) * zoom + panX;
      const sy = (rectStage.y * baseScale + baseOffsetY) * zoom + panY;
      const sw = rectStage.w * baseScale * zoom;
      const sh = rectStage.h * baseScale * zoom;
      ctx.save();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.restore();
    }

    if (overview.showCutPoints && overviewCutPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.lineWidth = 1;
      const radius = Math.max(2, Math.min(6, 2 + zoom));
      for (const point of overviewCutPoints) {
        const px = (point.x * baseScale + baseOffsetX) * zoom + panX;
        const py = (point.y * baseScale + baseOffsetY) * zoom + panY;
        if (px < -20 || px > canvas.width + 20 || py < -20 || py > canvas.height + 20) {
          continue;
        }
        ctx.fillStyle = CUT_POINT_COLORS[point.sample] ?? '#facc15';
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        overviewPointsRef.current.push({
          id: point.id,
          x: px,
          y: py,
          w: radius * 4,
          h: radius * 4
        });
      }
      ctx.restore();
    }

    if (overviewHoveredCutPointId) {
      const hovered = cutPointById.get(overviewHoveredCutPointId);
      if (hovered) {
        const px = (hovered.x * baseScale + baseOffsetX) * zoom + panX;
        const py = (hovered.y * baseScale + baseOffsetY) * zoom + panY;
        const fontSize = Math.max(11, Math.min(15, 10 + zoom * 0.6));
        const fontFamily = '"Source Sans 3", sans-serif';
        const normalFont = `${fontSize}px ${fontFamily}`;
        const boldFont = `600 ${fontSize}px ${fontFamily}`;
        const paddingX = 8;
        const paddingY = 6;
        const lineHeight = Math.max(14, Math.min(18, 12 + zoom * 0.6));
        const line1 = [{ text: hovered.code || '—', bold: true }];
        const line2 = [
          { text: hovered.plateLabel || '—', bold: false },
          { text: ' · ', bold: false },
          { text: hovered.well ? formatWellDisplay(hovered.well) : '—', bold: true }
        ];
        const xValue = formatNumber(hovered.x, 2);
        const yValue = formatNumber(hovered.y, 2);
        const line3 = [
          { text: 'X:', bold: true },
          { text: ` ${xValue}`, bold: false },
          { text: ', ', bold: false },
          { text: 'Y:', bold: true },
          { text: ` ${yValue}`, bold: false }
        ];
        const measureLine = (segments: Array<{ text: string; bold: boolean }>) =>
          segments.reduce((total, segment) => {
            ctx.font = segment.bold ? boldFont : normalFont;
            return total + ctx.measureText(segment.text).width;
          }, 0);
        const maxWidth = Math.max(measureLine(line1), measureLine(line2), measureLine(line3));
        const boxWidth = maxWidth + paddingX * 2;
        const boxHeight = lineHeight * 3 + paddingY * 2;
        let boxX = px + 12;
        let boxY = py - boxHeight - 12;
        if (boxX + boxWidth > canvas.width - 8) {
          boxX = px - boxWidth - 12;
        }
        if (boxX < 8) {
          boxX = 8;
        }
        if (boxY < 8) {
          boxY = py + 12;
        }
        ctx.fillStyle = CUT_POINT_TOOLTIP_BG[hovered.sample] ?? 'rgba(15, 23, 42, 0.85)';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.6)';
        ctx.lineWidth = 1;
        const radiusPx = 8;
        ctx.beginPath();
        ctx.moveTo(boxX + radiusPx, boxY);
        ctx.lineTo(boxX + boxWidth - radiusPx, boxY);
        ctx.quadraticCurveTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + radiusPx);
        ctx.lineTo(boxX + boxWidth, boxY + boxHeight - radiusPx);
        ctx.quadraticCurveTo(
          boxX + boxWidth,
          boxY + boxHeight,
          boxX + boxWidth - radiusPx,
          boxY + boxHeight
        );
        ctx.lineTo(boxX + radiusPx, boxY + boxHeight);
        ctx.quadraticCurveTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - radiusPx);
        ctx.lineTo(boxX, boxY + radiusPx);
        ctx.quadraticCurveTo(boxX, boxY, boxX + radiusPx, boxY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const drawSegments = (
          segments: Array<{ text: string; bold: boolean; align?: 'left' | 'right' }>,
          y: number,
          maxLineWidth: number
        ) => {
          const leftSegments = segments.filter((segment) => segment.align !== 'right');
          const rightSegments = segments.filter((segment) => segment.align === 'right');
          let cursorX = boxX + paddingX;
          for (const segment of leftSegments) {
            ctx.font = segment.bold ? boldFont : normalFont;
            ctx.fillText(segment.text, cursorX, y);
            cursorX += ctx.measureText(segment.text).width;
          }
          if (rightSegments.length) {
            let rightWidth = 0;
            for (const segment of rightSegments) {
              ctx.font = segment.bold ? boldFont : normalFont;
              rightWidth += ctx.measureText(segment.text).width;
            }
            let rightX = boxX + paddingX + maxLineWidth - rightWidth;
            for (const segment of rightSegments) {
              ctx.font = segment.bold ? boldFont : normalFont;
              ctx.fillText(segment.text, rightX, y);
              rightX += ctx.measureText(segment.text).width;
            }
          }
        };
        drawSegments(line1, boxY + paddingY, maxWidth);
        drawSegments(line2, boxY + paddingY + lineHeight, maxWidth);
        drawSegments(line3, boxY + paddingY + lineHeight * 2, maxWidth);
      }
    }
    if (overlayMessage) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = `${Math.max(14, canvas.width * 0.014)}px "Space Grotesk", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(overlayMessage, canvas.width / 2, canvas.height / 2);
      ctx.restore();
    }
  }, [
    overview,
    overviewCutPoints,
    overviewImageIds,
    orphanImageIds,
    mapElements,
    micronsPerPixel,
    imageOpacity,
    cutPointDisplay.visibleImageIds,
    overviewHoveredCutPointId,
    overviewSelection,
    overviewContours,
    activeOverviewContourAnchor,
    hoveredOverviewContourAnchor,
    activeOverviewContourId,
    overviewContourInsertPreview,
    overviewContourPreview,
    stagePosition,
    cutPointById,
    hasCoordinateInputs
  ]);

  useCanvasResize(mapCanvasRef, mapContainerRef, updateMap, activeTab);
  useCanvasResize(overviewCanvasRef, overviewContainerRef, updateOverview, activeTab);

  useEffect(() => {
    updateMap();
  }, [updateMap]);

  useEffect(() => {
    updateOverview();
  }, [updateOverview]);

  useEffect(() => {
    updateMapRef.current = updateMap;
  }, [updateMap]);

  useEffect(() => {
    updateOverviewRef.current = updateOverview;
  }, [updateOverview]);

  const resetCoordinateMapView = useCallback(() => {
    mapViewRef.current = {
      zoom: 1,
      panX: 0,
      panY: 0,
      isDragging: false,
      startX: 0,
      startY: 0,
      startPanX: 0,
      startPanY: 0,
      dragDistance: 0
    };
    mapBoundsRef.current = null;
  }, []);

  const handleFrameCoordinateCutPoints = useCallback(() => {
    if (visibleCoordinateCutPoints.length === 0) {
      setStatus('No visible cut points to frame.');
      return;
    }
    resetCoordinateMapView();
    setCoordinateFrameMode('cut-points');
    if (coordinateFrameMode === 'cut-points') {
      updateMapRef.current();
    }
    setStatus('Framed cut points.');
  }, [coordinateFrameMode, resetCoordinateMapView, visibleCoordinateCutPoints.length]);

  const handleFrameCoordinateImages = useCallback(() => {
    if (coordinateVisibleImagePoints.length === 0) {
      setStatus('No visible images to frame.');
      return;
    }
    resetCoordinateMapView();
    setCoordinateFrameMode('images');
    if (coordinateFrameMode === 'images') {
      updateMapRef.current();
    }
    setStatus('Framed images.');
  }, [coordinateFrameMode, coordinateVisibleImagePoints.length, resetCoordinateMapView]);

  useEffect(() => {
    if (!window.lifApi?.onCloseRequest) {
      return;
    }
    const cleanup = window.lifApi.onCloseRequest(() => {
      setClosePromptOpen(true);
    });
    return () => cleanup();
  }, []);

  useEffect(() => {
    if (
      !window.lifApi?.onSaveRequest ||
      !window.lifApi?.onLoadRequest ||
      !window.lifApi?.onNewProject
    ) {
      return;
    }
    const cleanupSave = window.lifApi.onSaveRequest((mode) => {
      void saveProjectHandlerRef.current(mode);
    });
    const cleanupLoad = window.lifApi.onLoadRequest((filePath) => {
      void loadProjectHandlerRef.current(undefined, filePath);
    });
    const cleanupNew = window.lifApi.onNewProject(() => {
      newProjectHandlerRef.current();
    });
    return () => {
      cleanupSave();
      cleanupLoad();
      cleanupNew();
    };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modPressed = isMac ? event.metaKey : event.ctrlKey;
      if (!modPressed || event.key.toLowerCase() !== 's') {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        (target && (target as HTMLElement).isContentEditable);
      if (isEditable) {
        return;
      }
      event.preventDefault();
      void saveProjectHandlerRef.current('save');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modPressed = isMac ? event.metaKey : event.ctrlKey;
      if (!modPressed || event.key.toLowerCase() !== 'f') {
        return;
      }
      event.preventDefault();
      if (activeTab === 'metadata') {
        metadataSearchRef.current?.focus();
        metadataSearchRef.current?.select();
        return;
      }
      if (activeTab === 'viewer') {
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modPressed = isMac ? event.metaKey : event.ctrlKey;
      if (!modPressed || event.key.toLowerCase() !== 'z') {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        (target && (target as HTMLElement).isContentEditable);
      if (isEditable) {
        return;
      }
      if (activeTab === 'overview') {
        event.preventDefault();
        void undoOverviewRef.current();
        return;
      }
      if (activeTab === 'viewer') {
        event.preventDefault();
        undoManualPointCreationRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (activeTab !== 'overview' || !activeOverviewContourAnchor) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        (target && (target as HTMLElement).isContentEditable);
      if (isEditable) {
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }
      event.preventDefault();
      pushOverviewHistory(overview);
      const { contourId, pointIndex } = activeOverviewContourAnchor;
      updateOverviewContours((contours) =>
        contours.map((contour) =>
          contour.id === contourId
            ? {
                ...contour,
                points: contour.points.filter((_, index) => index !== pointIndex)
              }
            : contour
        )
      );
      setActiveOverviewContourAnchor(null);
      setOverviewContourPreview(null);
      updateOverviewRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    activeOverviewContourAnchor,
    activeTab,
    overview,
    pushOverviewHistory,
    setActiveOverviewContourAnchor,
    setOverviewContourPreview,
    updateOverviewContours
  ]);

  useEffect(() => {
    mapViewRef.current = {
      zoom: 1,
      panX: 0,
      panY: 0,
      isDragging: false,
      startX: 0,
      startY: 0,
      dragDistance: 0
    };
    thumbCacheRef.current.clear();
    thumbInFlightRef.current.clear();
    thumbQueueRef.current = [];
    updateMapRef.current();
  }, [activeCryosection, lifFiles, elements]);

  useEffect(() => {
    overviewHistoryRef.current = createCryoStateArray(() => []);
  }, []);

  useEffect(() => {
    overviewViewRef.current = {
      zoom: 1,
      panX: 0,
      panY: 0,
      isDragging: false,
      startX: 0,
      startY: 0
    };
    updateOverviewRef.current();
  }, [activeCryosection, stagePosition]);


  const loadLifFiles = async (filePaths: string[], cryoIndex: number) => {
    if (!window.lifApi?.parseFile) {
      setError('Preload API unavailable. Check Electron preload setup.');
      setStatus('Preload API unavailable. Check Electron preload setup.');
      setErrorBanner('Preload API unavailable. Check Electron preload setup.');
      return;
    }
    if (!filePaths.length) {
      return;
    }

    const nextElements: UiElement[] = [];
    const errors: string[] = [];
    setStatus(`Parsing ${filePaths.length} file${filePaths.length > 1 ? 's' : ''}...`);
    setElementsByCryo((prev) => replaceAt(prev, cryoIndex, []));
    setSelectedIdByCryo((prev) => replaceAt(prev, cryoIndex, null));
    setSelectedIdsByCryo((prev) => replaceAt(prev, cryoIndex, new Set()));
    setOrphanImageVisibilityByCryo((prev) => replaceAt(prev, cryoIndex, {}));
    setLifFilesByCryo((prev) => replaceAt(prev, cryoIndex, filePaths));
    setSearch('');

    for (let index = 0; index < filePaths.length; index += 1) {
      const file = filePaths[index];
      const name = file.split(/[\\/]/).pop() ?? file;
      setStatus(`Parsing ${index + 1}/${filePaths.length}: ${name}`);
      const response: LifParseResponse = await window.lifApi.parseFile(file);
      if ('error' in response) {
        errors.push(`${name}: ${response.error}`);
        continue;
      }
      const fileElements = response.elements
        .filter((element) => !element.name.toLowerCase().includes('ins_wol'))
        .map((element) => ({
          ...element,
          sourceFile: response.filePath,
          uiId: `${response.filePath}::${element.id}`
        }));
      nextElements.push(...fileElements);
    }

    if (errors.length) {
      setError(errors.slice(0, 3).join(' | '));
      setErrorBanner(errors.slice(0, 1).join(' | '));
    } else {
      setError(null);
    }

    setElementsByCryo((prev) => replaceAt(prev, cryoIndex, nextElements));
    const firstId = nextElements[0]?.uiId ?? null;
    setSelectedIdByCryo((prev) => replaceAt(prev, cryoIndex, firstId));
    setSelectedIdsByCryo((prev) =>
      replaceAt(prev, cryoIndex, firstId ? new Set([firstId]) : new Set())
    );
    setStatus(nextElements.length ? 'Select an element to view.' : 'No elements found.');
    if (!errors.length) {
      setErrorBanner(null);
    }
  };

  const handleOpen = async () => {
    if (!window.lifApi?.openFiles) {
      setError('Preload API unavailable. Check Electron preload setup.');
      setStatus('Preload API unavailable. Check Electron preload setup.');
      setErrorBanner('Preload API unavailable. Check Electron preload setup.');
      return;
    }
    setError(null);
    const picked = await window.lifApi.openFiles();
    if (!picked || picked.length === 0) {
      return;
    }
    await loadLifFiles(picked, activeCryosection);
  };

  const loadCsvFiles = useCallback(
    async (
      filePaths: string[],
      cryoIndex: number,
      options?: {
        plateCount?: number;
        assignments?: PlateAssignment[];
        csvFilesByCryo?: string[][];
        csvSourceGroupIdsByCryo?: Array<string | null>;
      }
    ) => {
      if (!window.lifApi?.readCsv) {
        setError('Preload API unavailable. Check Electron preload setup.');
        setStatus('Preload API unavailable. Check Electron preload setup.');
        setErrorBanner('Preload API unavailable. Check Electron preload setup.');
        return false;
      }
      const allRows: RawCsvRow[] = [];
      let successfulReads = 0;
      let lastErrorMessage: string | null = null;
      for (const filePath of filePaths) {
        try {
          const text = await window.lifApi.readCsv(filePath);
          allRows.push(...parseCsvText(text));
          successfulReads += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to read CSV file.';
          lastErrorMessage = message;
          setError(message);
        }
      }
      if (filePaths.length > 0 && successfulReads === 0) {
        if (lastErrorMessage) {
          setStatus(lastErrorMessage);
        }
        return false;
      }
      const nextCsvFilesByCryo =
        options?.csvFilesByCryo ?? replaceAt(csvFilesByCryo, cryoIndex, [...filePaths]);
      const nextCsvSourceGroupIdsByCryo =
        options?.csvSourceGroupIdsByCryo ?? csvSourceGroupIdsByCryo;
      const { targets, totalAssignedColumns } = getCryoCsvTargets(cryoIndex, {
        plateCount: options?.plateCount,
        assignments: options?.assignments,
        csvFilesByCryo: nextCsvFilesByCryo,
        csvSourceGroupIdsByCryo: nextCsvSourceGroupIdsByCryo
      });
      const {
        resultPlates,
        placements,
        sourceColumnCount,
        ignoredRowCount,
        ignoredNonEllipseCount,
        ignoredZeroAreaCount
      } = buildCsvPlates(allRows, targets);
      manualPointUndoStackRef.current = [];
      setCsvPlacementsByCryo((prev) => replaceAt(prev, cryoIndex, placements));
      setCsvPlatesByCryo((prev) => replaceAt(prev, cryoIndex, resultPlates));
      const imageRows = allRows.filter((row) => row.imageNames.trim().length > 0).length;
      const coordRows = allRows.filter((row) => row.coords.trim().length > 0).length;
      const warningMessages: string[] = [];
      if (totalAssignedColumns > 12) {
        warningMessages.push(
          `${
            getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`
          } is assigned to ${totalAssignedColumns} CSV columns. Only source columns 1-12 are available; extra assignments were ignored.`
        );
      }
      if (ignoredRowCount > 0) {
        warningMessages.push(
          `${
            getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`
          } contains ${ignoredRowCount} suspicious CSV row${
            ignoredRowCount === 1 ? '' : 's'
          } that were ignored (${ignoredNonEllipseCount} non-Ellipse, ${ignoredZeroAreaCount} zero-area).`
        );
      }
      if (totalAssignedColumns > 0 && sourceColumnCount !== totalAssignedColumns) {
        warningMessages.push(
          `${
            getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`
          } resolved ${sourceColumnCount} source CSV columns, but the current session layout expects ${totalAssignedColumns}.`
        );
      }
      setErrorBanner(warningMessages.length ? warningMessages.join('\n') : null);
      console.log(
        `[csv] rows ${allRows.length}, image rows ${imageRows}, coord rows ${coordRows}, source columns ${sourceColumnCount}, ignored rows ${ignoredRowCount}`
      );
      return true;
    },
    [buildCsvPlates, csvFilesByCryo, csvSourceGroupIdsByCryo, getCryoCsvTargets, getCryosectionName]
  );

  const handleReuseCoordinateSources = useCallback(async () => {
    if (coordinatesReuseSource === null || coordinatesReuseSource === activeCryosection) {
      setErrorBanner('Select another cryosection to reuse its LIF and CSV files.');
      return;
    }
    const sourceLifFiles = lifFilesByCryo[coordinatesReuseSource] ?? [];
    const sourceElements = elementsByCryo[coordinatesReuseSource] ?? [];
    const sourceCsvFiles = csvFilesByCryo[coordinatesReuseSource] ?? [];
    if (sourceLifFiles.length === 0 && sourceCsvFiles.length === 0 && sourceElements.length === 0) {
      setErrorBanner('The selected cryosection has no imported LIF or CSV files to reuse.');
      return;
    }
    manualPointUndoStackRef.current = [];
    setLifFilesByCryo((prev) => replaceAt(prev, activeCryosection, [...sourceLifFiles]));
    setElementsByCryo((prev) =>
      replaceAt(
        prev,
        activeCryosection,
        sourceElements.map((item) => ({ ...item }))
      )
    );
    const nextCsvFilesByCryo = replaceAt(csvFilesByCryo, activeCryosection, [...sourceCsvFiles]);
    let nextCsvSourceGroupIdsByCryo = replaceAt(
      csvSourceGroupIdsByCryo,
      activeCryosection,
      csvSourceGroupIdsByCryo[activeCryosection] ?? null
    );
    if (sourceCsvFiles.length > 0) {
      const sharedGroupId =
        csvSourceGroupIdsByCryo[coordinatesReuseSource] ??
        csvSourceGroupIdsByCryo[activeCryosection] ??
        createCsvSourceGroupId();
      nextCsvSourceGroupIdsByCryo = replaceAt(
        nextCsvSourceGroupIdsByCryo,
        coordinatesReuseSource,
        sharedGroupId
      );
      nextCsvSourceGroupIdsByCryo = replaceAt(
        nextCsvSourceGroupIdsByCryo,
        activeCryosection,
        sharedGroupId
      );
    } else {
      nextCsvSourceGroupIdsByCryo = replaceAt(nextCsvSourceGroupIdsByCryo, activeCryosection, null);
    }
    nextCsvSourceGroupIdsByCryo = reconcileCsvSourceGroupIds(
      nextCsvFilesByCryo,
      nextCsvSourceGroupIdsByCryo
    );
    setCsvFilesByCryo(nextCsvFilesByCryo);
    setCsvSourceGroupIdsByCryo(nextCsvSourceGroupIdsByCryo);
    if (sourceCsvFiles.length > 0) {
      const loaded = await loadCsvFiles(sourceCsvFiles, activeCryosection, {
        csvFilesByCryo: nextCsvFilesByCryo,
        csvSourceGroupIdsByCryo: nextCsvSourceGroupIdsByCryo
      });
      if (loaded === false) {
        setErrorBanner(
          'The reused CSV files could not be reopened. Reimport the CSV file for this cryosection locally to rebuild its plate mapping.'
        );
      }
    } else {
      setCsvPlatesByCryo((prev) => replaceAt(prev, activeCryosection, [createCsvCells(), createCsvCells()]));
      setCsvPlacementsByCryo((prev) => replaceAt(prev, activeCryosection, []));
    }
    setSelectedIdByCryo((prev) =>
      replaceAt(prev, activeCryosection, selectedIdByCryo[coordinatesReuseSource] ?? sourceElements[0]?.uiId ?? null)
    );
    setSelectedIdsByCryo((prev) =>
      replaceAt(prev, activeCryosection, new Set(selectedIdsByCryo[coordinatesReuseSource] ?? []))
    );
    setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, new Set()));
    setCutPointSearch('');
    setCoordinatesReuseMenuOpen(false);
    setErrorBanner(null);
    setStatus(
      `Reused LIF and CSV files from ${getCryosectionName(coordinatesReuseSource) || `Cryosection ${coordinatesReuseSource + 1}`}.`
    );
  }, [
    activeCryosection,
    coordinatesReuseSource,
    csvFilesByCryo,
    csvSourceGroupIdsByCryo,
    elementsByCryo,
    getCryosectionName,
    lifFilesByCryo,
    loadCsvFiles,
    selectedIdByCryo,
    selectedIdsByCryo
  ]);

  const handleDetachCoordinateSources = useCallback(() => {
    const keysToClear = new Set<string>();
    for (let plateIndex = 0; plateIndex < visiblePlateCount; plateIndex += 1) {
      for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
        for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
          if (getCellCryoIndex(plateIndex, colIndex) !== activeCryosection) {
            continue;
          }
          keysToClear.add(`${plateIndex}-${rowIndex}-${colIndex}`);
        }
      }
    }
    const nextCoordinateCache = { ...coordinateCache };
    keysToClear.forEach((key) => {
      delete nextCoordinateCache[key];
    });

    manualPointUndoStackRef.current = [];
    setLifFilesByCryo((prev) => replaceAt(prev, activeCryosection, []));
    setCsvFilesByCryo((prev) => replaceAt(prev, activeCryosection, []));
    setCsvSourceGroupIdsByCryo((prev) => replaceAt(prev, activeCryosection, null));
    setElementsByCryo((prev) => replaceAt(prev, activeCryosection, []));
    setCsvPlatesByCryo((prev) => replaceAt(prev, activeCryosection, [createCsvCells(), createCsvCells()]));
    setCsvPlacementsByCryo((prev) => replaceAt(prev, activeCryosection, []));
    setSelectedIdByCryo((prev) => replaceAt(prev, activeCryosection, null));
    setSelectedIdsByCryo((prev) => replaceAt(prev, activeCryosection, new Set()));
    setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, new Set()));
    setCutPointVisibilityByCryo((prev) => replaceAt(prev, activeCryosection, {}));
    setOrphanImageVisibilityByCryo((prev) => replaceAt(prev, activeCryosection, {}));
    setCoordinateOverridesByCryo((prev) => replaceAt(prev, activeCryosection, {}));
    setCoordinateCache(nextCoordinateCache);
    setCoordinatesReady(Object.keys(nextCoordinateCache).length > 0);
    setCoordDebug('');
    setCutPointSearch('');
    setCoordinatesReuseMenuOpen(false);
    setCoordinatesCryosectionMenuOpen(false);
    setOrphanAssignmentPrompt(null);
    setManualCoordinatePrompt(null);
    setStatusPrompt(null);
    setError(null);
    setErrorBanner(null);
    setDetachCryoPromptOpen(false);
    setStatus(
      `Detached LIF and CSV sources from ${getCryosectionName(activeCryosection) || `Cryosection ${activeCryosection + 1}`}.`
    );
  }, [
    activeCryosection,
    coordinateCache,
    getCellCryoIndex,
    getCryosectionName,
    visiblePlateCount
  ]);

  const handleOpenCsv = async () => {
    if (!window.lifApi?.openCsv) {
      setError('Preload API unavailable. Check Electron preload setup.');
      setStatus('Preload API unavailable. Check Electron preload setup.');
      setErrorBanner('Preload API unavailable. Check Electron preload setup.');
      return;
    }
    setError(null);
    const picked = await window.lifApi.openCsv();
    if (!picked || picked.length === 0) {
      return;
    }
    const nextCsvFilesByCryo = replaceAt(csvFilesByCryo, activeCryosection, picked);
    const previousSourceFileNameKey = buildSourceFileNameKey(
      csvFilesByCryo[activeCryosection] ?? []
    );
    const nextSourceFileNameKey = buildSourceFileNameKey(picked);
    const matchedSourceCryoIndexes = createCryoStateArray((index) => index)
      .filter((index) => index !== activeCryosection)
      .filter(
        (index) =>
          nextSourceFileNameKey.length > 0 &&
          buildSourceFileNameKey(csvFilesByCryo[index] ?? []) === nextSourceFileNameKey
      );
    const preservedSourceGroupId =
      previousSourceFileNameKey.length > 0 &&
      previousSourceFileNameKey === nextSourceFileNameKey
        ? csvSourceGroupIdsByCryo[activeCryosection] ?? null
        : matchedSourceCryoIndexes
            .map((index) => csvSourceGroupIdsByCryo[index])
            .find((value): value is string => Boolean(value)) ??
          (matchedSourceCryoIndexes.length > 0 ? createCsvSourceGroupId() : null);
    let nextCsvSourceGroupsSeed = replaceAt(
      csvSourceGroupIdsByCryo,
      activeCryosection,
      preservedSourceGroupId
    );
    if (preservedSourceGroupId) {
      for (const index of matchedSourceCryoIndexes) {
        nextCsvSourceGroupsSeed = replaceAt(nextCsvSourceGroupsSeed, index, preservedSourceGroupId);
      }
    }
    const nextCsvSourceGroupIdsByCryo = reconcileCsvSourceGroupIds(
      nextCsvFilesByCryo,
      nextCsvSourceGroupsSeed
    );
    setCsvFilesByCryo(nextCsvFilesByCryo);
    setCsvSourceGroupIdsByCryo(nextCsvSourceGroupIdsByCryo);
    const loaded = await loadCsvFiles(picked, activeCryosection, {
      csvFilesByCryo: nextCsvFilesByCryo,
      csvSourceGroupIdsByCryo: nextCsvSourceGroupIdsByCryo
    });
    if (loaded === false) {
      return;
    }
    setStatus(`Loaded ${picked.length} CSV file${picked.length > 1 ? 's' : ''}.`);
  };

  const handleOpenOverviewImage = async (layerKey: 'pre' | 'post') => {
    if (!window.lifApi?.openOverviewImage) {
      setErrorBanner('Preload API unavailable. Check Electron preload setup.');
      return;
    }
    setOverviewState((state) => {
      state.activeLayer = layerKey;
      return state;
    });
    const picked = await window.lifApi.openOverviewImage();
    if (!picked) {
      return;
    }
    const bitmap = await loadOverviewBitmap(picked);
    if (!bitmap) {
      return;
    }
    setOverviewState((state) => {
      state[layerKey] = {
        ...state[layerKey],
        filePath: picked,
        bitmap,
        visible: true,
        offsetX: 0,
        offsetY: 0,
        scaleX: 1,
        scaleY: 1
      };
      if (state.linked) {
        const otherKey = layerKey === 'pre' ? 'post' : 'pre';
        state[otherKey] = {
          ...state[otherKey],
          offsetX: state[layerKey].offsetX,
          offsetY: state[layerKey].offsetY,
          scaleX: state[layerKey].scaleX,
          scaleY: state[layerKey].scaleY
        };
      }
      return state;
    });
  };

  const summarizeCoordinateCoverage = (platesToSummarize: MergedCsvCell[][][]) => {
    let totalCsv = 0;
    let withImageRef = 0;
    let withElement = 0;
    let withStage = 0;
    let withPixel = 0;
    let withAll = 0;
    const missingImages = new Set<string>();

    for (let plateIndex = 0; plateIndex < platesToSummarize.length; plateIndex += 1) {
      for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
        for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
          const cell = platesToSummarize[plateIndex]?.[rowIndex]?.[colIndex];
          if (!cell || !cell.present) {
            continue;
          }
          const sample = designPlates[plateIndex]?.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
          if (sample === DISABLED_SAMPLE) {
            continue;
          }
          totalCsv += 1;
          const referenceImage = isSingleLinkedImageCsvCell(cell)
            ? undefined
            : cell.preImage?.trim() || cell.cutImage?.trim();
          if (referenceImage) {
            withImageRef += 1;
          }
          const cryoIndex = cell.cryoIndex ?? getCellCryoIndex(plateIndex, colIndex) ?? 0;
          const { element } = resolveElementForImages(cryoIndex, cell.preImage, cell.cutImage);
          if (element) {
            withElement += 1;
            if (!element.stageX || !element.stageY || !element.width || !element.height) {
              // keep as missing stage
            } else {
              withStage += 1;
            }
          } else if (referenceImage) {
            if (missingImages.size < 5) {
              missingImages.add(referenceImage);
            }
          }
          if (cell.pixelX !== undefined && cell.pixelY !== undefined) {
            withPixel += 1;
          }
          if (
            element &&
            element.stageX !== undefined &&
            element.stageY !== undefined &&
            element.width !== undefined &&
            element.height !== undefined &&
            cell.pixelX !== undefined &&
            cell.pixelY !== undefined
          ) {
            withAll += 1;
          }
        }
      }
    }

    const summary = `CSV cells ${totalCsv}, image-ref ${withImageRef}, matched element ${withElement}, stage ${withStage}, pixel ${withPixel}, ready ${withAll}`;
    const missingList = missingImages.size
      ? `Missing images (sample): ${Array.from(missingImages).join(', ')}`
      : '';
    return { summary, missingList };
  };

  const buildCoordinateCache = (platesToBuild: MergedCsvCell[][][]) => {
    const cache: Record<string, { x: number; y: number }> = {};
    for (let plateIndex = 0; plateIndex < platesToBuild.length; plateIndex += 1) {
      for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
        for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
          const csvCell = platesToBuild[plateIndex]?.[rowIndex]?.[colIndex];
          if (!csvCell || !csvCell.present) {
            continue;
          }
          const sample = designPlates[plateIndex]?.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
          if (sample === DISABLED_SAMPLE) {
            continue;
          }
          const referenceImage = isSingleLinkedImageCsvCell(csvCell)
            ? undefined
            : csvCell.preImage?.trim() || csvCell.cutImage?.trim();
          if (!referenceImage) {
            continue;
          }
          if (csvCell.pixelX === undefined || csvCell.pixelY === undefined) {
            continue;
          }
          const cryoIndex = csvCell.cryoIndex ?? getCellCryoIndex(plateIndex, colIndex) ?? 0;
          const { element } = resolveElementForImages(cryoIndex, csvCell.preImage, csvCell.cutImage);
          if (
            !element ||
            element.stageX === undefined ||
            element.stageY === undefined ||
            element.width === undefined ||
            element.height === undefined
          ) {
            continue;
          }
          const originX = element.stageX - (element.width * micronsPerPixel) / 2;
          const originY = element.stageY - (element.height * micronsPerPixel) / 2;
          const x = originX + csvCell.pixelX * micronsPerPixel;
          const y = originY + csvCell.pixelY * micronsPerPixel;
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            continue;
          }
          cache[`${plateIndex}-${rowIndex}-${colIndex}`] = { x, y };
        }
      }
    }
    return cache;
  };

  const handleCalculateCoordinates = () => {
    const hasAny = assignedCryosectionIndexes.some(
      (index) => lifFilesByCryo[index]?.length > 0 && (csvFilesByCryo[index]?.length ?? 0) > 0
    );
    if (!hasAny) {
      setStatus('Load LIF and CSV files before calculating coordinates.');
      return;
    }
    const mergedForCalculation = mergeCsvPlatesData(csvPlatesByCryo);
    const cache = buildCoordinateCache(mergedForCalculation);
    for (let plateIndex = 0; plateIndex < mergedForCalculation.length; plateIndex += 1) {
      for (let rowIndex = 0; rowIndex < PLATE_ROWS.length; rowIndex += 1) {
        for (let colIndex = 0; colIndex < PLATE_COLS.length; colIndex += 1) {
          const cell = mergedForCalculation[plateIndex]?.[rowIndex]?.[colIndex];
          if (
            !cell?.present ||
            cell.manualAssigned !== true ||
            !isManualCoordinateLabel(cell.images)
          ) {
            continue;
          }
          const cacheKey = `${plateIndex}-${rowIndex}-${colIndex}`;
          const cached = coordinateCache[cacheKey];
          const hasOverride =
            (coordinateOverridesByCryo[cell.cryoIndex ?? getCellCryoIndex(plateIndex, colIndex) ?? 0] ??
              {})[cacheKey] === true;
          if (cached && hasOverride) {
            cache[cacheKey] = cached;
          }
        }
      }
    }
    const { summary, missingList } = summarizeCoordinateCoverage(mergedForCalculation);
    setCoordinateCache(cache);
    setCoordinatesReady(true);
    setStatus(`Coordinates calculated. ${summary}`);
    const debugText = [summary, missingList].filter(Boolean).join('\n');
    setCoordDebug(debugText);
    console.log('[coordinates]', summary);
    if (missingList) {
      console.log('[coordinates]', missingList);
    }
  };

  const findClosestMapPoint = (x: number, y: number, dpr: number) => {
    const hits = mapPointsRef.current.filter((point) => {
      const left = point.x - point.w / 2;
      const right = point.x + point.w / 2;
      const top = point.y - point.h / 2;
      const bottom = point.y + point.h / 2;
      return x >= left && x <= right && y >= top && y <= bottom;
    });

    let closest: { id: string; dist: number } | null = null;
    for (const point of hits.length ? hits : mapPointsRef.current) {
      const dx = point.x - x;
      const dy = point.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 12 * dpr && (!closest || dist < closest.dist)) {
        closest = { id: point.id, dist };
      }
    }
    return closest;
  };

  const findHoveredMapOrphanImage = (x: number, y: number) => {
    for (let index = mapOrphanImageRectsRef.current.length - 1; index >= 0; index -= 1) {
      const image = mapOrphanImageRectsRef.current[index];
      const left = image.x - image.w / 2;
      const right = image.x + image.w / 2;
      const top = image.y - image.h / 2;
      const bottom = image.y + image.h / 2;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        return image.id;
      }
    }
    return null;
  };

  const mapCanvasToStage = (x: number, y: number) => {
    const { baseScale, baseOffsetX, baseOffsetY } = mapTransformRef.current;
    const { zoom, panX, panY } = mapViewRef.current;
    const worldX = (x - panX) / zoom;
    const worldY = (y - panY) / zoom;
    return {
      x: (worldX - baseOffsetX) / baseScale,
      y: (worldY - baseOffsetY) / baseScale
    };
  };

  const updateCutPointCoordinates = (
    ids: string[],
    originCoords: Record<string, { x: number; y: number }>,
    deltaX: number,
    deltaY: number
  ) => {
    if (!ids.length || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return;
    }
    setCoordinateOverridesByCryo((prev) => {
      const current = { ...(prev[activeCryosection] ?? {}) };
      for (const id of ids) {
        current[id] = true;
      }
      return replaceAt(prev, activeCryosection, current);
    });
    setCoordinateCache((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        const base = originCoords[id];
        if (!base) {
          continue;
        }
        const x = base.x + deltaX;
        const y = base.y + deltaY;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }
        const current = prev[id];
        if (current && current.x === x && current.y === y) {
          continue;
        }
        next[id] = { x, y };
        changed = true;
      }
      if (!changed) {
        return prev;
      }
      return next;
    });
  };

  const handleMapClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (event.clientX - rect.left) * dpr;
    const y = (event.clientY - rect.top) * dpr;
    const closest = findClosestMapPoint(x, y, dpr);
    const orphanId = coordinateOrphansEnabled ? findHoveredMapOrphanImage(x, y) : null;

    if (closest) {
      setSelectedCutIdsByCryo((prev) =>
        replaceAt(
          prev,
          activeCryosection,
          event.shiftKey
            ? new Set([...(prev[activeCryosection] ?? new Set<string>()), closest.id])
            : new Set([closest.id])
        )
      );
    } else if (orphanId) {
      openOrphanAssignmentPrompt(orphanId, x, y);
    } else if (!event.shiftKey) {
      setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, new Set()));
    }
  };

  const getMapHoverCursor = (cutPointId: string | null, orphanId: string | null) => {
    if (cutPointId) {
      return 'move';
    }
    if (orphanId) {
      return 'help';
    }
    return 'crosshair';
  };

  const handleMapPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 2) {
      mapViewRef.current.isDragging = true;
      mapViewRef.current.startX = event.clientX;
      mapViewRef.current.startY = event.clientY;
      mapViewRef.current.startPanX = mapViewRef.current.panX;
      mapViewRef.current.startPanY = mapViewRef.current.panY;
      mapViewRef.current.dragDistance = 0;
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const startX = (event.clientX - rect.left) * dpr;
    const startY = (event.clientY - rect.top) * dpr;
    const hit = findClosestMapPoint(startX, startY, dpr);
    if (hit) {
      const selectedSet = new Set(selectedCutIds);
      if (event.shiftKey) {
        selectedSet.add(hit.id);
      } else {
        selectedSet.clear();
        selectedSet.add(hit.id);
      }
      setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, selectedSet));

      const originCoords: Record<string, { x: number; y: number }> = {};
      for (const id of selectedSet) {
        const point = cutPointById.get(id);
        if (point) {
          originCoords[id] = { x: point.x, y: point.y };
        }
      }
      if (!originCoords[hit.id]) {
        const fallback = cutPointById.get(hit.id);
        if (fallback) {
          originCoords[hit.id] = { x: fallback.x, y: fallback.y };
        }
      }
      const dragIds = Object.keys(originCoords);
      if (dragIds.length === 0) {
        return;
      }
      const startStage = mapCanvasToStage(startX, startY);
      mapPointDragRef.current = {
        active: true,
        moved: false,
        shift: event.shiftKey,
        anchorId: hit.id,
        ids: dragIds,
        originCoords,
        startCanvasX: startX,
        startCanvasY: startY,
        startStageX: startStage.x,
        startStageY: startStage.y
      };
      canvas.style.cursor = 'move';
      return;
    }
    selectionRef.current = {
      isSelecting: true,
      startX,
      startY,
      endX: startX,
      endY: startY,
      dragDistance: 0
    };
    updateMap();
  };

  const handleMapPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (event.clientX - rect.left) * dpr;
    const y = (event.clientY - rect.top) * dpr;
    mapHoverPositionRef.current = { x, y };

    if (mapPointDragRef.current.active) {
      const drag = mapPointDragRef.current;
      const movedDistance =
        Math.abs(x - drag.startCanvasX) + Math.abs(y - drag.startCanvasY);
      if (!drag.moved && movedDistance >= 4 * dpr) {
        mapPointDragRef.current.moved = true;
      }
      if (mapPointDragRef.current.moved) {
        const stage = mapCanvasToStage(x, y);
        const deltaX = stage.x - drag.startStageX;
        const deltaY = stage.y - drag.startStageY;
        updateCutPointCoordinates(drag.ids, drag.originCoords, deltaX, deltaY);
      }
      if (drag.anchorId && hoveredCutPointId !== drag.anchorId) {
        setHoveredCutPointId(drag.anchorId);
      }
      if (hoveredOrphanImageId !== null) {
        setHoveredOrphanImageId(null);
      }
      canvas.style.cursor = 'move';
      return;
    }

    if (selectionRef.current.isSelecting) {
      const nextX = x;
      const nextY = y;
      selectionRef.current.dragDistance +=
        Math.abs(nextX - selectionRef.current.endX) +
        Math.abs(nextY - selectionRef.current.endY);
      selectionRef.current.endX = nextX;
      selectionRef.current.endY = nextY;
      updateMap();
      return;
    }

    if (!mapViewRef.current.isDragging) {
      const closest = findClosestMapPoint(x, y, dpr);
      const nextId = closest ? closest.id : null;
      if (nextId !== hoveredCutPointId) {
        setHoveredCutPointId(nextId);
      }
      const nextOrphanId =
        nextId || !coordinateOrphansEnabled ? null : findHoveredMapOrphanImage(x, y);
      if (nextOrphanId !== hoveredOrphanImageId) {
        setHoveredOrphanImageId(nextOrphanId);
        updateMap();
      } else if (nextOrphanId) {
        updateMap();
      }
      canvas.style.cursor = getMapHoverCursor(nextId, nextOrphanId);
    }

    if (!mapViewRef.current.isDragging) {
      return;
    }
    const totalDx = event.clientX - mapViewRef.current.startX;
    const totalDy = event.clientY - mapViewRef.current.startY;
    const dragDistance = Math.abs(totalDx) + Math.abs(totalDy);
    mapViewRef.current.dragDistance = dragDistance;
    if (dragDistance < 6 * dpr) {
      canvas.style.cursor = 'grab';
      return;
    }
    mapViewRef.current.panX = mapViewRef.current.startPanX + totalDx * dpr;
    mapViewRef.current.panY = mapViewRef.current.startPanY + totalDy * dpr;
    canvas.style.cursor = 'grabbing';
    updateMap();
  };

  const handleMapPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (mapPointDragRef.current.active) {
      const drag = mapPointDragRef.current;
      if (!drag.moved && drag.anchorId && !drag.shift) {
        setSelectedCutIdsByCryo((prev) =>
          replaceAt(prev, activeCryosection, new Set([drag.anchorId as string]))
        );
      }
      mapPointDragRef.current = {
        active: false,
        moved: false,
        shift: false,
        anchorId: null,
        ids: [],
        originCoords: {},
        startCanvasX: 0,
        startCanvasY: 0,
        startStageX: 0,
        startStageY: 0
      };
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const x = (event.clientX - rect.left) * dpr;
        const y = (event.clientY - rect.top) * dpr;
        const closest = findClosestMapPoint(x, y, dpr);
        const nextId = closest ? closest.id : null;
        if (nextId !== hoveredCutPointId) {
          setHoveredCutPointId(nextId);
        }
        const nextOrphanId =
          nextId || !coordinateOrphansEnabled ? null : findHoveredMapOrphanImage(x, y);
        if (nextOrphanId !== hoveredOrphanImageId) {
          setHoveredOrphanImageId(nextOrphanId);
          updateMap();
        } else if (nextOrphanId) {
          updateMap();
        }
        canvas.style.cursor = getMapHoverCursor(nextId, nextOrphanId);
      }
      return;
    }
    if (selectionRef.current.isSelecting) {
      const selection = selectionRef.current;
      selectionRef.current.isSelecting = false;
      updateMap();
      if (selection.dragDistance < 6) {
        handleMapClick(event as unknown as MouseEvent<HTMLCanvasElement>);
        return;
      }
      const left = Math.min(selection.startX, selection.endX);
      const right = Math.max(selection.startX, selection.endX);
      const top = Math.min(selection.startY, selection.endY);
      const bottom = Math.max(selection.startY, selection.endY);
      const hits = mapPointsRef.current.filter((point) => {
        const pointLeft = point.x - point.w / 2;
        const pointRight = point.x + point.w / 2;
        const pointTop = point.y - point.h / 2;
        const pointBottom = point.y + point.h / 2;
        return !(pointRight < left || pointLeft > right || pointBottom < top || pointTop > bottom);
      });
      if (hits.length) {
        const nextIds = new Set(hits.map((hit) => hit.id));
        setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, nextIds));
      } else {
        setSelectedCutIdsByCryo((prev) => replaceAt(prev, activeCryosection, new Set()));
      }
      return;
    }

    if (mapViewRef.current.isDragging) {
      const wasRightClick =
        event.button === 2 && mapViewRef.current.dragDistance < 6 * (window.devicePixelRatio || 1);
      mapViewRef.current.isDragging = false;
      if (wasRightClick) {
        mapViewRef.current.panX = mapViewRef.current.startPanX;
        mapViewRef.current.panY = mapViewRef.current.startPanY;
        const rect = canvas?.getBoundingClientRect();
        if (canvas && rect) {
          const dpr = window.devicePixelRatio || 1;
          const x = (mapViewRef.current.startX - rect.left) * dpr;
          const y = (mapViewRef.current.startY - rect.top) * dpr;
          const stage = mapCanvasToStage(x, y);
          openManualCoordinatePrompt(stage.x, stage.y);
          updateMap();
        }
      }
      if (canvas) {
        canvas.style.cursor = getMapHoverCursor(hoveredCutPointId, hoveredOrphanImageId);
      }
    }
  };

  const handleMapPointerLeave = () => {
    const canvas = mapCanvasRef.current;
    if (canvas && !mapPointDragRef.current.active && !mapViewRef.current.isDragging) {
      canvas.style.cursor = '';
    }
    mapHoverPositionRef.current = null;
    if (!mapPointDragRef.current.active) {
      setHoveredCutPointId(null);
      setHoveredOrphanImageId(null);
    }
  };

  const handleMapWheel = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault();
    const canvas = mapCanvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (event.clientX - rect.left) * dpr;
    const sy = (event.clientY - rect.top) * dpr;

    const { baseScale, baseOffsetX, baseOffsetY } = mapTransformRef.current;
    const { zoom, panX, panY } = mapViewRef.current;

    const worldX = (sx - panX) / zoom;
    const worldY = (sy - panY) / zoom;
    const stageX = (worldX - baseOffsetX) / baseScale;
    const stageY = (worldY - baseOffsetY) / baseScale;

    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    const nextZoom = Math.min(30, Math.max(0.2, zoom * delta));
    mapViewRef.current.zoom = nextZoom;

    const nextWorldX = stageX * baseScale + baseOffsetX;
    const nextWorldY = stageY * baseScale + baseOffsetY;
    mapViewRef.current.panX = sx - nextWorldX * nextZoom;
    mapViewRef.current.panY = sy - nextWorldY * nextZoom;
    updateMap();
  };

  const handleOverviewPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = overviewCanvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 2) {
      overviewViewRef.current.isDragging = true;
      overviewViewRef.current.startX = event.clientX;
      overviewViewRef.current.startY = event.clientY;
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (event.clientX - rect.left) * dpr;
    const sy = (event.clientY - rect.top) * dpr;
    const { baseScale, baseOffsetX, baseOffsetY } = overviewTransformRef.current;
    const { zoom, panX, panY } = overviewViewRef.current;
    const worldX = (sx - panX) / zoom;
    const worldY = (sy - panY) / zoom;
    const stageX = (worldX - baseOffsetX) / baseScale;
    const stageY = (worldY - baseOffsetY) / baseScale;
    const stageToCanvas = (x: number, y: number) => ({
      x: (x * baseScale + baseOffsetX) * zoom + panX,
      y: (y * baseScale + baseOffsetY) * zoom + panY
    });
    const contourHitRadius = 10 * dpr;
    const hitContourAnchor = overviewContourAnchorsRef.current
      .filter((anchor) => !activeOverviewContourId || anchor.contourId === activeOverviewContourId)
      .find((anchor) => {
        const dx = anchor.x - sx;
        const dy = anchor.y - sy;
        return Math.sqrt(dx * dx + dy * dy) <= contourHitRadius;
      });

    if (activeOverviewContourId) {
      const activeContour = overviewContours.find((contour) => contour.id === activeOverviewContourId);
      const hasActiveContour = Boolean(activeContour);
      if (!hasActiveContour) {
        setActiveOverviewContour(null);
        setActiveOverviewContourAnchor(null);
        setOverviewContourPreview(null);
        return;
      }
      if (hitContourAnchor) {
        pushOverviewHistory(overview);
        setActiveOverviewContourAnchor({
          contourId: hitContourAnchor.contourId,
          pointIndex: hitContourAnchor.pointIndex
        });
        setHoveredOverviewContourAnchor({
          contourId: hitContourAnchor.contourId,
          pointIndex: hitContourAnchor.pointIndex
        });
        setOverviewContourInsertPreview(null);
        overviewContourDragRef.current = {
          active: true,
          contourId: hitContourAnchor.contourId,
          pointIndex: hitContourAnchor.pointIndex
        };
        updateOverviewRef.current();
        return;
      }
      if (activeContour && activeContour.points.length >= 2) {
        const segmentHit = closestPolylineSegmentIndex(
          sx,
          sy,
          activeContour.points.map((point) => stageToCanvas(point.x, point.y)),
          activeContour.closed
        );
        if (segmentHit && segmentHit.distance <= contourHitRadius) {
          pushOverviewHistory(overview);
          const insertIndex = Math.min(activeContour.points.length, segmentHit.index + 1);
          updateOverviewContours((contours) =>
            contours.map((contour) =>
              contour.id === activeOverviewContourId
                ? {
                    ...contour,
                    points: [
                      ...contour.points.slice(0, insertIndex),
                      { x: stageX, y: stageY },
                      ...contour.points.slice(insertIndex)
                    ]
                  }
                : contour
            )
          );
          setActiveOverviewContourAnchor({
            contourId: activeOverviewContourId,
            pointIndex: insertIndex
          });
          setHoveredOverviewContourAnchor(null);
          setOverviewContourInsertPreview(null);
          setOverviewContourPreview({ x: stageX, y: stageY });
          setOverviewHoveredCutPointId(null);
          updateOverviewRef.current();
          return;
        }
      }
      updateOverviewContours((contours) =>
        contours.map((contour) =>
          contour.id === activeOverviewContourId
            ? {
                ...contour,
                points: [...contour.points, { x: stageX, y: stageY }]
              }
            : contour
        )
      );
      setActiveOverviewContourAnchor({
        contourId: activeOverviewContourId,
        pointIndex:
          (overviewContours.find((contour) => contour.id === activeOverviewContourId)?.points.length ??
            0)
      });
      setHoveredOverviewContourAnchor(null);
      setOverviewContourInsertPreview(null);
      setOverviewContourPreview({ x: stageX, y: stageY });
      setOverviewHoveredCutPointId(null);
      updateOverviewRef.current();
      return;
    }

    const getSelectionHandle = (
      sx: number,
      sy: number,
      rectStage: { x: number; y: number; w: number; h: number },
      dpr: number
    ) => {
      const { baseScale, baseOffsetX, baseOffsetY } = overviewTransformRef.current;
      const { zoom, panX, panY } = overviewViewRef.current;
      const left = (rectStage.x * baseScale + baseOffsetX) * zoom + panX;
      const top = (rectStage.y * baseScale + baseOffsetY) * zoom + panY;
      const right = left + rectStage.w * baseScale * zoom;
      const bottom = top + rectStage.h * baseScale * zoom;
      const handleSize = 8 * dpr;
      const near = (ax: number, ay: number) =>
        Math.abs(sx - ax) <= handleSize && Math.abs(sy - ay) <= handleSize;
      if (near(left, top)) return 'nw';
      if (near(right, top)) return 'ne';
      if (near(left, bottom)) return 'sw';
      if (near(right, bottom)) return 'se';
      if (Math.abs(sy - top) <= handleSize && sx >= left && sx <= right) return 'n';
      if (Math.abs(sy - bottom) <= handleSize && sx >= left && sx <= right) return 's';
      if (Math.abs(sx - left) <= handleSize && sy >= top && sy <= bottom) return 'w';
      if (Math.abs(sx - right) <= handleSize && sy >= top && sy <= bottom) return 'e';
      if (sx > left && sx < right && sy > top && sy < bottom) return 'move';
      return null;
    };

    if (overviewSelection.enabled) {
      let mode: 'new' | 'move' | 'resize' = 'new';
      let handle: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' = 'move';
      let startRect = overviewSelection.rect ? normalizeRect(overviewSelection.rect) : null;
      if (startRect) {
        const dpr = window.devicePixelRatio || 1;
        const hit = getSelectionHandle(sx, sy, startRect, dpr);
        if (hit) {
          mode = 'move';
          handle = hit;
          if (hit !== 'move') {
            mode = 'resize';
          }
        }
      }

      if (mode === 'new' || !startRect) {
        startRect = { x: stageX, y: stageY, w: 0, h: 0 };
      }

      overviewSelectionRef.current = {
        isSelecting: true,
        mode,
        handle,
        startStageX: stageX,
        startStageY: stageY,
        startRect
      };

      if (mode === 'new') {
        setOverviewSelection((state) => ({
          ...state,
          rect: { x: stageX, y: stageY, w: 0, h: 0 }
        }));
      }
      updateOverview();
      return;
    }

    const layerKey = overview.activeLayer;
    const layer = overview[layerKey];
    const rectStage = getOverviewLayerRect(layer);
    if (!rectStage) {
      return;
    }
    const left = Math.min(rectStage.x, rectStage.x + rectStage.w);
    const right = Math.max(rectStage.x, rectStage.x + rectStage.w);
    const top = Math.min(rectStage.y, rectStage.y + rectStage.h);
    const bottom = Math.max(rectStage.y, rectStage.y + rectStage.h);
    const inImage = stageX >= left && stageX <= right && stageY >= top && stageY <= bottom;
    if (inImage) {
      pushOverviewHistory(overview);
      overviewDragRef.current = {
        isDragging: true,
        layer: layerKey,
        startStageX: stageX,
        startStageY: stageY,
        startOffsetX: layer.offsetX,
        startOffsetY: layer.offsetY
      };
    }
  };

  const handleOverviewPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = overviewCanvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (event.clientX - rect.left) * dpr;
    const y = (event.clientY - rect.top) * dpr;
    const { baseScale, baseOffsetX, baseOffsetY } = overviewTransformRef.current;
    const { zoom, panX, panY } = overviewViewRef.current;
    const worldX = (x - panX) / zoom;
    const worldY = (y - panY) / zoom;
    const stageX = (worldX - baseOffsetX) / baseScale;
    const stageY = (worldY - baseOffsetY) / baseScale;
    const contourHitRadius = 10 * dpr;
    const hoveredContourAnchor = overviewContourAnchorsRef.current
      .filter((anchor) => !activeOverviewContourId || anchor.contourId === activeOverviewContourId)
      .find((anchor) => {
        const dx = anchor.x - x;
        const dy = anchor.y - y;
        return Math.sqrt(dx * dx + dy * dy) <= contourHitRadius;
      });

    if (overviewContourDragRef.current.active) {
      const { contourId, pointIndex } = overviewContourDragRef.current;
      if (contourId) {
        updateOverviewContours((contours) =>
          contours.map((contour) =>
            contour.id === contourId
              ? {
                  ...contour,
                  points: contour.points.map((point, index) =>
                    index === pointIndex ? { x: stageX, y: stageY } : point
                  )
                }
              : contour
          )
        );
        setOverviewContourPreview({ x: stageX, y: stageY });
        canvas.style.cursor = 'grabbing';
        updateOverviewRef.current();
      }
      return;
    }

    if (overviewSelection.enabled && overviewSelectionRef.current.isSelecting) {
      const { mode, handle, startRect, startStageX, startStageY } = overviewSelectionRef.current;
      const aspect = getSelectionStageAspect(overviewSelection.aspect);
      const minSize = 1;

      if (mode === 'move') {
        const dx = stageX - startStageX;
        const dy = stageY - startStageY;
        setOverviewSelection((state) => ({
          ...state,
          rect: { x: startRect.x + dx, y: startRect.y + dy, w: startRect.w, h: startRect.h }
        }));
        updateOverview();
        return;
      }

      if (mode === 'new') {
        let w = stageX - startStageX;
        let h = stageY - startStageY;
      if (aspect > 0) {
        const absW = Math.abs(w);
        const absH = Math.abs(h);
          if (absW >= absH) {
            const sign = h === 0 ? (w >= 0 ? 1 : -1) : Math.sign(h);
            h = sign * absW * aspect;
          } else {
            const sign = w === 0 ? (h >= 0 ? 1 : -1) : Math.sign(w);
            w = sign * absH / aspect;
          }
        }
        setOverviewSelection((state) => ({
          ...state,
          rect: { x: startStageX, y: startStageY, w, h }
        }));
        updateOverview();
        return;
      }

      const base = startRect;
      const left = base.x;
      const right = base.x + base.w;
      const top = base.y;
      const bottom = base.y + base.h;
      let newLeft = left;
      let newRight = right;
      let newTop = top;
      let newBottom = bottom;
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;

      if (handle.includes('e')) {
        newRight = stageX;
      }
      if (handle.includes('w')) {
        newLeft = stageX;
      }
      if (handle.includes('n')) {
        newTop = stageY;
      }
      if (handle.includes('s')) {
        newBottom = stageY;
      }

      let width = Math.max(minSize, Math.abs(newRight - newLeft));
      let height = Math.max(minSize, Math.abs(newBottom - newTop));

      if (aspect > 0) {
        const isCorner = handle.length === 2;
        if (isCorner) {
          const widthFromHeight = height / aspect;
          if (width >= widthFromHeight) {
            height = width * aspect;
          } else {
            width = widthFromHeight;
            height = width * aspect;
          }
        } else if (handle === 'e' || handle === 'w') {
          height = width * aspect;
        } else if (handle === 'n' || handle === 's') {
          width = height / aspect;
        }

        if (handle === 'e') {
          newLeft = left;
          newRight = left + width;
          newTop = centerY - height / 2;
          newBottom = centerY + height / 2;
        } else if (handle === 'w') {
          newRight = right;
          newLeft = right - width;
          newTop = centerY - height / 2;
          newBottom = centerY + height / 2;
        } else if (handle === 'n') {
          newBottom = bottom;
          newTop = bottom - height;
          newLeft = centerX - width / 2;
          newRight = centerX + width / 2;
        } else if (handle === 's') {
          newTop = top;
          newBottom = top + height;
          newLeft = centerX - width / 2;
          newRight = centerX + width / 2;
        } else if (handle === 'ne') {
          newLeft = left;
          newBottom = bottom;
          newRight = left + width;
          newTop = bottom - height;
        } else if (handle === 'nw') {
          newRight = right;
          newBottom = bottom;
          newLeft = right - width;
          newTop = bottom - height;
        } else if (handle === 'se') {
          newLeft = left;
          newTop = top;
          newRight = left + width;
          newBottom = top + height;
        } else if (handle === 'sw') {
          newRight = right;
          newTop = top;
          newLeft = right - width;
          newBottom = top + height;
        }
      }

      const rectUpdated = normalizeRect({
        x: newLeft,
        y: newTop,
        w: newRight - newLeft,
        h: newBottom - newTop
      });

      setOverviewSelection((state) => ({
        ...state,
        rect: rectUpdated
      }));
      updateOverview();
      return;
    }

    if (overviewDragRef.current.isDragging) {
      const deltaX = stageX - overviewDragRef.current.startStageX;
      const deltaY = stageY - overviewDragRef.current.startStageY;
      updateOverviewLayer(
        overviewDragRef.current.layer,
        (layer) => ({
        ...layer,
        offsetX: overviewDragRef.current.startOffsetX + deltaX,
        offsetY: overviewDragRef.current.startOffsetY + deltaY
        }),
        { pushHistory: false }
      );
      canvas.style.cursor = 'grabbing';
      updateOverview();
      return;
    }

    if (overviewViewRef.current.isDragging) {
      const dx = event.clientX - overviewViewRef.current.startX;
      const dy = event.clientY - overviewViewRef.current.startY;
      overviewViewRef.current.startX = event.clientX;
      overviewViewRef.current.startY = event.clientY;
      overviewViewRef.current.panX += dx * (window.devicePixelRatio || 1);
      overviewViewRef.current.panY += dy * (window.devicePixelRatio || 1);
      canvas.style.cursor = 'grabbing';
      updateOverview();
      return;
    }

    if (activeOverviewContourId) {
      const activeContour = overviewContours.find((contour) => contour.id === activeOverviewContourId);
      const hoveredContourSegment =
        activeContour && activeContour.points.length >= 2
          ? closestPolylineSegmentIndex(
              x,
              y,
              activeContour.points.map((point) => ({
                x: (point.x * baseScale + baseOffsetX) * zoom + panX,
                y: (point.y * baseScale + baseOffsetY) * zoom + panY
              })),
              activeContour.closed
            )
          : undefined;
      if (hoveredContourAnchor) {
        setHoveredOverviewContourAnchor({
          contourId: hoveredContourAnchor.contourId,
          pointIndex: hoveredContourAnchor.pointIndex
        });
        setOverviewContourInsertPreview(null);
      } else if (hoveredContourSegment && hoveredContourSegment.distance <= contourHitRadius) {
        setHoveredOverviewContourAnchor(null);
        setOverviewContourInsertPreview({
          contourId: activeOverviewContourId,
          pointIndex: Math.min(
            activeContour?.points.length ?? 0,
            hoveredContourSegment.index + 1
          ),
          x: stageX,
          y: stageY
        });
      } else {
        setHoveredOverviewContourAnchor(null);
        setOverviewContourInsertPreview(null);
      }
      setOverviewContourPreview({ x: stageX, y: stageY });
      const nextCursor = hoveredContourAnchor
        ? 'grab'
        : hoveredContourSegment && hoveredContourSegment.distance <= contourHitRadius
          ? 'copy'
          : 'crosshair';
      if (canvas.style.cursor !== nextCursor) {
        canvas.style.cursor = nextCursor;
      }
      if (overviewHoveredCutPointId !== null) {
        setOverviewHoveredCutPointId(null);
      }
      updateOverviewRef.current();
      return;
    }

    if (overviewSelection.enabled) {
      let cursor = 'crosshair';
      if (overviewSelection.rect) {
        const rectStage = normalizeRect(overviewSelection.rect);
        const { baseScale, baseOffsetX, baseOffsetY } = overviewTransformRef.current;
        const { zoom, panX, panY } = overviewViewRef.current;
        const left = (rectStage.x * baseScale + baseOffsetX) * zoom + panX;
        const top = (rectStage.y * baseScale + baseOffsetY) * zoom + panY;
        const right = left + rectStage.w * baseScale * zoom;
        const bottom = top + rectStage.h * baseScale * zoom;
        const handleSize = 8 * dpr;
        const near = (ax: number, ay: number) =>
          Math.abs(x - ax) <= handleSize && Math.abs(y - ay) <= handleSize;
        let handle: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | null = null;
        if (near(left, top)) handle = 'nw';
        else if (near(right, top)) handle = 'ne';
        else if (near(left, bottom)) handle = 'sw';
        else if (near(right, bottom)) handle = 'se';
        else if (Math.abs(y - top) <= handleSize && x >= left && x <= right) handle = 'n';
        else if (Math.abs(y - bottom) <= handleSize && x >= left && x <= right) handle = 's';
        else if (Math.abs(x - left) <= handleSize && y >= top && y <= bottom) handle = 'w';
        else if (Math.abs(x - right) <= handleSize && y >= top && y <= bottom) handle = 'e';
        else if (x > left && x < right && y > top && y < bottom) handle = 'move';
        if (handle) {
          cursor = cursorForHandle(handle);
        }
      }
      if (canvas.style.cursor !== cursor) {
        canvas.style.cursor = cursor;
      }
    }
    let closest: { id: string; dist: number } | null = null;
    for (const point of overviewPointsRef.current) {
      const dx = point.x - x;
      const dy = point.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 12 * dpr && (!closest || dist < closest.dist)) {
        closest = { id: point.id, dist };
      }
    }
    const nextId = closest ? closest.id : null;
    if (nextId !== overviewHoveredCutPointId) {
      setOverviewHoveredCutPointId(nextId);
    }
    if (!overviewSelection.enabled) {
      const rectStage = getOverviewLayerRect(activeOverviewLayer);
      const inActiveImage = rectStage
        ? stageX >= Math.min(rectStage.x, rectStage.x + rectStage.w) &&
          stageX <= Math.max(rectStage.x, rectStage.x + rectStage.w) &&
          stageY >= Math.min(rectStage.y, rectStage.y + rectStage.h) &&
          stageY <= Math.max(rectStage.y, rectStage.y + rectStage.h)
        : false;
      const nextCursor = inActiveImage ? 'grab' : 'crosshair';
      if (canvas.style.cursor !== nextCursor) {
        canvas.style.cursor = nextCursor;
      }
    }
  };

  const handleOverviewPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = overviewCanvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (overviewSelection.enabled && overviewSelectionRef.current.isSelecting) {
      overviewSelectionRef.current.isSelecting = false;
    }
    overviewContourDragRef.current = {
      active: false,
      contourId: null,
      pointIndex: -1
    };
    overviewDragRef.current.isDragging = false;
    if (overviewViewRef.current.isDragging) {
      overviewViewRef.current.isDragging = false;
    }
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (event.clientX - rect.left) * dpr;
      const y = (event.clientY - rect.top) * dpr;
      const { baseScale, baseOffsetX, baseOffsetY } = overviewTransformRef.current;
      const { zoom, panX, panY } = overviewViewRef.current;
      const worldX = (x - panX) / zoom;
      const worldY = (y - panY) / zoom;
      const stageX = (worldX - baseOffsetX) / baseScale;
      const stageY = (worldY - baseOffsetY) / baseScale;
      const rectStage = getOverviewLayerRect(activeOverviewLayer);
      const inActiveImage = rectStage
        ? stageX >= Math.min(rectStage.x, rectStage.x + rectStage.w) &&
          stageX <= Math.max(rectStage.x, rectStage.x + rectStage.w) &&
          stageY >= Math.min(rectStage.y, rectStage.y + rectStage.h) &&
          stageY <= Math.max(rectStage.y, rectStage.y + rectStage.h)
        : false;
      const contourHitRadius = 10 * dpr;
      const hoveredContourAnchor = overviewContourAnchorsRef.current
        .filter((anchor) => !activeOverviewContourId || anchor.contourId === activeOverviewContourId)
        .find((anchor) => {
          const dx = anchor.x - x;
          const dy = anchor.y - y;
          return Math.sqrt(dx * dx + dy * dy) <= contourHitRadius;
        });
      if (activeOverviewContourId) {
        canvas.style.cursor = hoveredContourAnchor ? 'grab' : 'crosshair';
      } else {
        canvas.style.cursor = inActiveImage ? 'grab' : 'crosshair';
      }
    }
  };

  const handleOverviewDoubleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!activeOverviewContourId) {
      return;
    }
    event.preventDefault();
    finishOverviewContour();
  };

  const handleOverviewPointerLeave = () => {
    setOverviewHoveredCutPointId(null);
    setHoveredOverviewContourAnchor(null);
    setOverviewContourInsertPreview(null);
    if (activeOverviewContourId) {
      setOverviewContourPreview(null);
      updateOverviewRef.current();
    }
    const canvas = overviewCanvasRef.current;
    if (canvas) {
      canvas.style.cursor = '';
    }
  };

  const handleOverviewWheel = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault();
    const canvas = overviewCanvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (event.clientX - rect.left) * dpr;
    const sy = (event.clientY - rect.top) * dpr;

    const { baseScale, baseOffsetX, baseOffsetY } = overviewTransformRef.current;
    const { zoom, panX, panY } = overviewViewRef.current;

    const worldX = (sx - panX) / zoom;
    const worldY = (sy - panY) / zoom;
    const stageX = (worldX - baseOffsetX) / baseScale;
    const stageY = (worldY - baseOffsetY) / baseScale;

    if (event.altKey) {
      const delta = event.deltaY > 0 ? 0.95 : 1.05;
      const layerKey = overview.activeLayer;
      const rectStage = getOverviewLayerRect(overview[layerKey]);
      if (!rectStage) {
        return;
      }
      pushOverviewHistory(overview);
      const relX = (stageX - rectStage.x) / rectStage.w;
      const relY = (stageY - rectStage.y) / rectStage.h;
      const nextScaleX = Math.min(1.6, Math.max(0.4, overview[layerKey].scaleX * delta));
      const nextScaleY = Math.min(1.6, Math.max(0.4, overview[layerKey].scaleY * delta));
      const nextOffsetX = stageX - rectStage.baseX - relX * rectStage.baseW * nextScaleX;
      const nextOffsetY = stageY - rectStage.baseY - relY * rectStage.baseH * nextScaleY;
      updateOverviewLayer(
        layerKey,
        (layer) => ({
          ...layer,
          scaleX: nextScaleX,
          scaleY: nextScaleY,
          offsetX: nextOffsetX,
          offsetY: nextOffsetY
        }),
        { pushHistory: false }
      );
      updateOverview();
      return;
    }

    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    const nextZoom = Math.min(30, Math.max(0.2, zoom * delta));
    overviewViewRef.current.zoom = nextZoom;

    const nextWorldX = stageX * baseScale + baseOffsetX;
    const nextWorldY = stageY * baseScale + baseOffsetY;
    overviewViewRef.current.panX = sx - nextWorldX * nextZoom;
    overviewViewRef.current.panY = sy - nextWorldY * nextZoom;
    updateOverview();
  };

  const queueThumbnailLoads = (desired: Map<string, ThumbnailRequest>) => {
    const maxThumbs = 6;
    const cache = thumbCacheRef.current;
    const inFlight = thumbInFlightRef.current;
    const queue = thumbQueueRef.current;

    let added = 0;
    for (const [key, payload] of desired.entries()) {
      const cached = cache.get(key);
      if (cached && cached.size >= payload.size) {
        continue;
      }
      const inflightSize = inFlight.get(key);
      if (inflightSize && inflightSize >= payload.size) {
        continue;
      }
      const queuedIndex = queue.findIndex((entry) => entry.key === key);
      if (queuedIndex !== -1) {
        if (queue[queuedIndex].size < payload.size) {
          queue[queuedIndex].size = payload.size;
        }
        continue;
      }
      queue.push({
        key,
        size: payload.size,
        elementId: payload.elementId,
        sourceFile: payload.sourceFile
      });
      added += 1;
      if (added >= maxThumbs) {
        break;
      }
    }

    pumpThumbnailQueue();
  };
  queueThumbnailLoadsRef.current = queueThumbnailLoads;

  const pumpThumbnailQueue = () => {
    const inFlight = thumbInFlightRef.current;
    const queue = thumbQueueRef.current;
    const maxConcurrent = 1;

    while (inFlight.size < maxConcurrent && queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      inFlight.set(next.key, next.size);
      void loadThumbnail(next.key, next.elementId, next.sourceFile, next.size).finally(() => {
        inFlight.delete(next.key);
        pumpThumbnailQueue();
      });
    }
  };

  const loadThumbnail = useCallback(async (
    key: string,
    elementId: string,
    sourceFile: string,
    targetSize: number
  ) => {
    const cached = thumbCacheRef.current.get(key);
    if (cached && cached.size >= targetSize) {
      return cached;
    }
    const response = window.lifApi.loadThumbnail
      ? await window.lifApi.loadThumbnail(sourceFile, elementId, targetSize)
      : await window.lifApi.loadImage(sourceFile, elementId);
    if ('error' in response) {
      return undefined;
    }

    const rgb = new Uint8ClampedArray(response.data);
    const canvas = document.createElement('canvas');
    canvas.width = response.width;
    canvas.height = response.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return undefined;
    }

    const imageData = ctx.createImageData(response.width, response.height);
    const data = imageData.data;
    for (let y = 0; y < response.height; y += 1) {
      for (let x = 0; x < response.width; x += 1) {
        const srcIndex = (y * response.width + x) * 3;
        const dstIndex = (y * response.width + x) * 4;
        data[dstIndex] = rgb[srcIndex];
        data[dstIndex + 1] = rgb[srcIndex + 1];
        data[dstIndex + 2] = rgb[srcIndex + 2];
        data[dstIndex + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const thumb = {
      canvas,
      width: response.width,
      height: response.height,
      size: Math.max(response.width, response.height)
    };
    thumbCacheRef.current.set(key, thumb);
    updateMapRef.current();
    updateOverviewRef.current();
    return thumb;
  }, []);

  const orphanAssignmentPreviewPixel = useMemo(() => {
    if (!orphanAssignmentPrompt) {
      return { x: undefined, y: undefined };
    }
    if (!selectedOrphanAssignmentTarget) {
      return {
        x: orphanAssignmentPrompt.pixelX,
        y: orphanAssignmentPrompt.pixelY
      };
    }
    const selectedCell =
      csvPlatesByCryo[activeCryosection]?.[selectedOrphanAssignmentTarget.plateIndex]?.[
        selectedOrphanAssignmentTarget.rowIndex
      ]?.[selectedOrphanAssignmentTarget.colIndex];
    return {
      x: selectedCell?.pixelX ?? orphanAssignmentPrompt.pixelX,
      y: selectedCell?.pixelY ?? orphanAssignmentPrompt.pixelY
    };
  }, [activeCryosection, csvPlatesByCryo, orphanAssignmentPrompt, selectedOrphanAssignmentTarget]);

  const orphanAssignmentSelectionHasMixedStages = useMemo(() => {
    if (selectedOrphanAssignmentImages.length < 2) {
      return false;
    }
    const [{ stageX, stageY }] = selectedOrphanAssignmentImages;
    return selectedOrphanAssignmentImages.some(
      (option) => option.stageX !== stageX || option.stageY !== stageY
    );
  }, [selectedOrphanAssignmentImages]);

  const toggleOrphanAssignmentImage = useCallback(
    (imageKey: string) => {
      const option = orphanAssignmentImageOptionsByKey.get(imageKey);
      if (!option) {
        return;
      }
      setSelectedOrphanAssignmentImageKeys((prev) => {
        if (prev.includes(imageKey)) {
          return prev.filter((key) => key !== imageKey);
        }
        const current = prev
          .map((key) => orphanAssignmentImageOptionsByKey.get(key))
          .filter((value): value is OrphanAssignmentImageOption => Boolean(value));
        const sameStageSelection = current.filter(
          (item) => item.stageX === option.stageX && item.stageY === option.stageY
        );
        const next = sameStageSelection
          .filter((item) => item.group !== option.group)
          .map((item) => item.key);
        next.push(imageKey);
        return next;
      });
    },
    [orphanAssignmentImageOptionsByKey]
  );

  useEffect(() => {
    if (!orphanAssignmentPrompt) {
      setSelectedOrphanAssignmentTargetKey(null);
      setSelectedOrphanAssignmentImageKeys([]);
      setOrphanAssignmentPreviewState({});
      return;
    }
    setSelectedOrphanAssignmentTargetKey(orphanAssignmentPrompt.initialTargetKey ?? null);
    setSelectedOrphanAssignmentImageKeys([]);
  }, [orphanAssignmentPrompt]);

  useEffect(() => {
    setSelectedOrphanAssignmentImageKeys([]);
  }, [selectedOrphanAssignmentTargetKey]);

  useEffect(() => {
    if (!orphanAssignmentPrompt) {
      setOrphanAssignmentPreviewState({});
      return;
    }

    let cancelled = false;
    const nextState = Object.fromEntries(
      orphanAssignmentPrompt.imageOptions.map((option) => [option.key, { loading: true }])
    ) as Record<string, OrphanAssignmentPreviewState>;
    setOrphanAssignmentPreviewState(nextState);

    const loadPreview = async (option: OrphanAssignmentImageOption) => {
      try {
        const thumb = await loadThumbnail(
          `${option.sourceFile}::${option.elementId}`,
          option.elementId,
          option.sourceFile,
          360
        );
        if (!cancelled) {
          setOrphanAssignmentPreviewState((prev) => ({
            ...prev,
            [option.key]: thumb
              ? { loading: false, thumb }
              : { loading: false, error: 'Image preview is unavailable in the loaded LIF files.' }
          }));
        }
      } catch {
        if (!cancelled) {
          setOrphanAssignmentPreviewState((prev) => ({
            ...prev,
            [option.key]: { loading: false, error: 'Image preview could not be loaded.' }
          }));
        }
      }
    };

    for (const option of orphanAssignmentPrompt.imageOptions) {
      void loadPreview(option);
    }

    return () => {
      cancelled = true;
    };
  }, [loadThumbnail, orphanAssignmentPrompt]);

  const isSaved = lastSavedSnapshot && !hasUnsavedChanges;
  const saveStatusLabel = isSaved ? 'Saved' : 'Unsaved';
  const activeSessionUsers =
    sessions.find((session) => session.id === currentSessionId)?.users ?? selectedSessionUsers;
  const currentUserLabel = formatSessionUsers(activeSessionUsers);
  const sessionStatusFor = (session: SessionEntry) => {
    if (session.status === 'open') {
      return 'Open';
    }
    if (session.status === 'closed') {
      return 'Closed';
    }
    if (session.status === 'interrupted') {
      return 'Interrupted';
    }
    if (session.endTime) {
      return 'Closed';
    }
    if (session.id === currentSessionId) {
      return 'Open';
    }
    return 'Interrupted';
  };
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ??
    (sessions.length ? sessions[sessions.length - 1] : null);
  const selectedSessionStatus = selectedSession ? sessionStatusFor(selectedSession) : '—';

  return (
    <div className="app">
      <div className="window-drag-region">
        <div className="drag-content">
          <div className="drag-spacer" />
          <div className="drag-center">
            <span className="drag-project">{projectName || 'New session'}</span>
            <span className={`drag-status-tag ${isSaved ? 'saved' : 'unsaved'}`}>
              {saveStatusLabel}
            </span>
          </div>
          <div className="drag-right">
            <span className="drag-label">User</span>
            <span className="drag-user">{currentUserLabel}</span>
          </div>
        </div>
      </div>
      <header className="topbar">
        <div className="logo-wrap">
          <img className="app-logo" src={logo} alt="LMDmapper" />
        </div>
        <div className="tabs-wrap">
          <div className="tabs">
            <button
              type="button"
              className={`tab-button ${activeTab === 'project' ? 'active' : ''}`}
              onClick={() => setActiveTab('project')}
            >
              Session
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'design' ? 'active' : ''}`}
              onClick={() => setActiveTab('design')}
            >
              Design
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'metadata' ? 'active' : ''}`}
              onClick={() => setActiveTab('metadata')}
            >
              Metadata
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'collection' ? 'active' : ''}`}
              onClick={() => setActiveTab('collection')}
            >
              Collection
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'viewer' ? 'active' : ''}`}
              onClick={() => setActiveTab('viewer')}
            >
              Coordinates
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === 'overview' ? 'active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
          </div>
          <div className="session-select">
            <span className="session-label">Session</span>
            <select
              value={selectedSessionId ?? ''}
              onChange={(event) =>
                setSelectedSessionId(event.target.value || null)
              }
              disabled={sessions.length === 0}
            >
              {sessions.length === 0 ? (
                <option value="">No sessions</option>
              ) : null}
              {sessions.map((session, index) => {
                const status = sessionStatusFor(session);
                return (
                  <option key={session.id} value={session.id}>
                    {`Session ${index + 1} · ${formatSessionUsers(session.users)} · ${status}`}
                  </option>
                );
              })}
            </select>
            {selectedSession ? (
              <span
                className={`session-status ${selectedSessionStatus.toLowerCase()}`}
              >
                {selectedSessionStatus}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <div className="content">
        {activeTab === 'project' ? (
          <section className="project-layout">
            <aside className="sidebar project-sidebar">
              <div className="sidebar-header">
                <div>
                  <div className="app-title">Session</div>
                  <div className="app-subtitle">Define the session scope</div>
                </div>
              </div>
              <div className="sidebar-status">
                Define cryosections, stage positions, plate count, and plate-to-cryosection
                assignments here before moving into Design, Metadata, Collection, and Coordinates.
              </div>
            </aside>
            <div className="project-card">
              <div className="plate-title">Session setup</div>
              <div className="project-form project-form-wide">
                <label className="form-field">
                  <div className="field-label-row">
                    <span>Session ID</span>
                    <span className="field-hint">e.g. S001</span>
                  </div>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                </label>

                <div className="project-step-card">
                  <div className="project-step-head">
                    <div className="project-step-title">1. Cryosections</div>
                    <div className="project-step-note">Select how many cryosections this session contains.</div>
                  </div>
                  <div className="project-count-buttons">
                    {[1, 2, 3, 4].map((value) => (
                      <button
                        key={`cryo-count-${value}`}
                        type="button"
                        className={`count-button ${cryosectionCount === value ? 'active' : ''}`}
                        onClick={() => setCryosectionCount(value as 1 | 2 | 3 | 4)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                  <div
                    className="project-cryosection-grid"
                    style={{
                      gridTemplateColumns: `repeat(${Math.max(1, cryosectionCount)}, minmax(0, 1fr))`
                    }}
                  >
                    {Array.from({ length: cryosectionCount }, (_, index) => {
                      const cryo = cryosections[index] ?? {
                        name: '',
                        color: getDefaultCryosectionColor(index),
                        stagePosition: DEFAULT_STAGE_POSITION
                      };
                      return (
                        <div key={`project-cryo-${index}`} className="project-cryosection-card">
                          <label className="form-field">
                            <span className="tooltip-label main-label">
                              {`Cryosection / Specimen ID ${index + 1}`}
                              <span className="tooltip-bubble">
                                {index === 0
                                  ? 'The first cryosection of this session'
                                  : `The ${index + 1}th cryosection of this session`}
                              </span>
                            </span>
                            <input
                              type="text"
                              value={cryo.name}
                              onChange={(event) => updateCryosectionName(index, event.target.value)}
                            />
                          </label>
                          <label className="form-field">
                            <span className="form-label">Color</span>
                            <div className="project-color-picker-row">
                              <input
                                type="color"
                                className="project-color-input"
                                value={cryo.color}
                                onChange={(event) =>
                                  updateCryosectionColor(index, event.target.value)
                                }
                                aria-label={`Cryosection ${index + 1} color`}
                              />
                              <span className="project-color-value">{cryo.color}</span>
                            </div>
                          </label>
                          <div className="form-field">
                            <span className="form-label tooltip-label">
                              Stage Position
                              <span className="tooltip-bubble">
                                the position at which the slide was located for microdissection
                              </span>
                            </span>
                            <div className="stage-selector project-stage-selector">
                              {[1, 2, 3, 4].map((value) => (
                                <button
                                  key={`cryo-stage-${index}-${value}`}
                                  type="button"
                                  className={`stage-option ${
                                    cryo.stagePosition === value ? 'active' : ''
                                  }`}
                                  onClick={() => updateCryosectionStagePosition(index, value)}
                                >
                                  {value}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="project-step-card">
                  <div className="project-step-head">
                    <div className="project-step-title">2. Plates</div>
                    <div className="project-step-note">Select how many 96-well plates are needed, then assign cryosections to full plates or half-plates.</div>
                  </div>
                  <div className="project-count-buttons">
                    {[1, 2].map((value) => (
                      <button
                        key={`plate-count-${value}`}
                        type="button"
                        className={`count-button ${plateCount === value ? 'active' : ''}`}
                        onClick={() => setPlateCount(value as 1 | 2)}
                      >
                        {value} {value === 1 ? 'plate' : 'plates'}
                      </button>
                    ))}
                  </div>
                  <div className="project-plate-config-grid">
                    {visiblePlateIndexes.map((plateIndex) => {
                      const assignment = getPlateAssignment(plateIndex);
                      const activeSegment =
                        selectedProjectSegment?.plateIndex === plateIndex
                          ? selectedProjectSegment.segmentIndex
                          : null;
                      const getSegmentSummary = (segmentIndex: 0 | 1) => {
                        const segment = assignment.segments[segmentIndex];
                        const cryoIndex = segment?.cryoIndex ?? null;
                        return {
                          name:
                            cryoIndex === null
                              ? 'Unassigned'
                              : getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`,
                          color: getCryosectionColor(cryoIndex),
                          positive: String(
                            effectivePositiveStarts[plateIndex]?.[segmentIndex] ??
                              segment?.positiveStart ??
                              DEFAULT_MICROSAMPLE_START
                          ).padStart(3, '0'),
                          negative: String(
                            effectiveNegativeStarts[plateIndex]?.[segmentIndex] ??
                              segment?.negativeStart ??
                              DEFAULT_MICROSAMPLE_START
                          ).padStart(3, '0')
                        };
                      };
                      const leftSegmentSummary = getSegmentSummary(0);
                      const rightSegmentSummary = getSegmentSummary(1);
                      return (
                        <div key={`project-plate-${plateIndex}`} className="project-plate-config-card">
                          <div className="project-plate-config-head">
                            <label className="form-field">
                              <div className="field-label-row">
                                <span className="tooltip-label main-label">
                                  {`Plate / Batch ID ${plateIndex + 1}`}
                                  <span className="tooltip-bubble">
                                    {plateIndex === 0
                                      ? 'Batch code for the first plate'
                                      : 'Batch code for the second plate'}
                                  </span>
                                </span>
                              </div>
                              <input
                                type="text"
                                value={plateBatchIds[plateIndex]}
                                onChange={(event) =>
                                  updatePlateBatchId(plateIndex, event.target.value)
                                }
                              />
                            </label>
                            <div className="project-split-toggle">
                              <button
                                type="button"
                                className={`count-button ${!assignment.split ? 'active' : ''}`}
                                onClick={() =>
                                  updatePlateAssignment(plateIndex, (current) => ({
                                    ...current,
                                    split: false
                                  }))
                                }
                              >
                                Whole plate
                              </button>
                              <button
                                type="button"
                                className={`count-button ${assignment.split ? 'active' : ''}`}
                                onClick={() =>
                                  updatePlateAssignment(plateIndex, (current) => ({
                                    ...current,
                                    split: true
                                  }))
                                }
                              >
                                Split 6+6
                              </button>
                            </div>
                          </div>

                          <div className={`project-plate-preview ${assignment.split ? 'split' : 'full'}`}>
                            {activeSegment !== null ? (
                              <div
                                className={`project-segment-editor ${
                                  assignment.split
                                    ? activeSegment === 0
                                      ? 'left'
                                      : 'right'
                                    : 'full'
                                }`}
                              >
                                <div className="project-segment-editor-title">
                                  {assignment.split
                                    ? activeSegment === 0
                                      ? 'Selected half-plate: columns 1-6'
                                      : 'Selected half-plate: columns 7-12'
                                    : 'Selected segment: full plate'}
                                </div>
                                <div className="project-segment-editor-grid">
                                  <label className="form-field">
                                    <span>Cryosection</span>
                                    <select
                                      value={assignment.segments[activeSegment]?.cryoIndex ?? ''}
                                      onChange={(event) => {
                                        const value = event.target.value;
                                        updatePlateSegmentAssignment(
                                          plateIndex,
                                          activeSegment,
                                          (segment) => ({
                                            ...segment,
                                            positiveStart: DEFAULT_MICROSAMPLE_START,
                                            positiveManual: false,
                                            negativeStart: DEFAULT_MICROSAMPLE_START,
                                            negativeManual: false,
                                            cryoIndex:
                                              value === '' ? null : Number.parseInt(value, 10)
                                          })
                                        );
                                      }}
                                    >
                                      <option value="">Unassigned</option>
                                      {Array.from({ length: cryosectionCount }, (_, index) => (
                                        <option
                                          key={`segment-cryo-${plateIndex}-${activeSegment}-${index}`}
                                          value={index}
                                        >
                                          {cryosections[index]?.name || `Cryosection ${index + 1}`}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <label className="form-field">
                                    <span>Positive</span>
                                    <input
                                      type="text"
                                      value={String(
                                        effectivePositiveStarts[plateIndex]?.[activeSegment] ??
                                          assignment.segments[activeSegment]?.positiveStart ??
                                          DEFAULT_MICROSAMPLE_START
                                      )}
                                      onChange={(event) => {
                                        const digits = event.target.value.replace(/\D/g, '');
                                        if (!digits) {
                                          updatePlateSegmentAssignment(
                                            plateIndex,
                                            activeSegment,
                                            (segment) => ({
                                              ...segment,
                                              positiveStart: DEFAULT_MICROSAMPLE_START,
                                              positiveManual: false
                                            })
                                          );
                                          return;
                                        }
                                        const next = Math.max(1, Number.parseInt(digits, 10));
                                        updatePlateSegmentAssignment(
                                          plateIndex,
                                          activeSegment,
                                          (segment) => ({
                                            ...segment,
                                            positiveStart: next,
                                            positiveManual: true
                                          })
                                        );
                                      }}
                                    />
                                  </label>
                                  <label className="form-field">
                                    <span>Negative</span>
                                    <input
                                      type="text"
                                      value={String(
                                        effectiveNegativeStarts[plateIndex]?.[activeSegment] ??
                                          assignment.segments[activeSegment]?.negativeStart ??
                                          DEFAULT_MICROSAMPLE_START
                                      )}
                                      onChange={(event) => {
                                        const digits = event.target.value.replace(/\D/g, '');
                                        if (!digits) {
                                          updatePlateSegmentAssignment(
                                            plateIndex,
                                            activeSegment,
                                            (segment) => ({
                                              ...segment,
                                              negativeStart: DEFAULT_MICROSAMPLE_START,
                                              negativeManual: false
                                            })
                                          );
                                          return;
                                        }
                                        const next = Math.max(1, Number.parseInt(digits, 10));
                                        updatePlateSegmentAssignment(
                                          plateIndex,
                                          activeSegment,
                                          (segment) => ({
                                            ...segment,
                                            negativeStart: next,
                                            negativeManual: true
                                          })
                                        );
                                      }}
                                    />
                                  </label>
                                </div>
                              </div>
                            ) : null}
                            <div className="project-plate-circle-grid">
                              {PLATE_ROWS.map((_, rowIndex) =>
                                PLATE_COLS.map((_, colIndex) => {
                                  const segmentIndex = assignment.split && colIndex >= 6 ? 1 : 0;
                                  const cryoIndex = assignment.segments[segmentIndex]?.cryoIndex;
                                  const color =
                                    cryoIndex !== null && cryoIndex !== undefined
                                      ? getCryosectionColor(cryoIndex)
                                      : 'rgba(148, 163, 184, 0.26)';
                                  return (
                                    <span
                                      key={`project-circle-${plateIndex}-${rowIndex}-${colIndex}`}
                                      className="project-plate-circle"
                                      style={{ backgroundColor: color }}
                                    />
                                  );
                                })
                              )}
                            </div>
                            <button
                              type="button"
                              className={`project-segment-overlay full ${
                                activeSegment === 0 && !assignment.split ? 'active' : ''
                              }`}
                              onClick={() =>
                                setSelectedProjectSegment({ plateIndex, segmentIndex: 0 })
                              }
                            >
                              {assignment.split ? null : (
                                <span
                                  className="project-segment-summary"
                                  style={
                                    {
                                      '--segment-accent': leftSegmentSummary.color
                                    } as CSSProperties
                                  }
                                >
                                  <span className="project-segment-summary-name">
                                    {leftSegmentSummary.name}
                                  </span>
                                  <span className="project-segment-summary-values">
                                    <strong>P</strong> {leftSegmentSummary.positive}
                                    <strong>N</strong> {leftSegmentSummary.negative}
                                  </span>
                                </span>
                              )}
                            </button>
                            {assignment.split ? (
                              <>
                                <button
                                  type="button"
                                  className={`project-segment-overlay left ${
                                    activeSegment === 0 ? 'active' : ''
                                  }`}
                                  onClick={() =>
                                    setSelectedProjectSegment({ plateIndex, segmentIndex: 0 })
                                  }
                                >
                                  <span
                                    className="project-segment-summary"
                                    style={
                                      {
                                        '--segment-accent': leftSegmentSummary.color
                                      } as CSSProperties
                                    }
                                  >
                                    <span className="project-segment-summary-name">
                                      {leftSegmentSummary.name}
                                    </span>
                                    <span className="project-segment-summary-values">
                                      <strong>P</strong> {leftSegmentSummary.positive}
                                      <strong>N</strong> {leftSegmentSummary.negative}
                                    </span>
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className={`project-segment-overlay right ${
                                    activeSegment === 1 ? 'active' : ''
                                  }`}
                                  onClick={() =>
                                    setSelectedProjectSegment({ plateIndex, segmentIndex: 1 })
                                  }
                                >
                                  <span
                                    className="project-segment-summary"
                                    style={
                                      {
                                        '--segment-accent': rightSegmentSummary.color
                                      } as CSSProperties
                                    }
                                  >
                                    <span className="project-segment-summary-name">
                                      {rightSegmentSummary.name}
                                    </span>
                                    <span className="project-segment-summary-values">
                                      <strong>P</strong> {rightSegmentSummary.positive}
                                      <strong>N</strong> {rightSegmentSummary.negative}
                                    </span>
                                  </span>
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <label className="form-field">
                  <span>Description</span>
                  <textarea
                    value={projectDescription}
                    onChange={(event) => setProjectDescription(event.target.value)}
                    rows={5}
                  />
                </label>
              </div>
            </div>
          </section>
        ) : activeTab === 'design' ? (
          <section className="design-layout" onClick={clearPlateSelection}>
            <aside className="design-sidebar">
              <div className="control-title">Sample Type</div>
              <div className="sample-buttons">
                {SAMPLE_OPTIONS.map((option) => (
                  <button
                    key={option.type}
                    type="button"
                    className={`sample-button sample-${option.type}`}
                    disabled={designLocked}
                    onClick={(event) => {
                      event.stopPropagation();
                      applySampleType(option.type);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="random-params-box">
                <div className="random-action-row">
                  <button
                    type="button"
                    className="sample-button random-button"
                    onClick={randomAssignment}
                    disabled={designLocked}
                  >
                    Random assignment
                  </button>
                  <button
                    type="button"
                    className={`random-params-toggle ${randomParamsOpen ? 'active' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRandomParamsOpen((prev) => !prev);
                    }}
                    aria-label={randomParamsOpen ? 'Hide random parameters' : 'Show random parameters'}
                    title={randomParamsOpen ? 'Hide parameters' : 'Show parameters'}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M10.8 2.5h2.4l.5 2.2a7.8 7.8 0 0 1 1.6.7l1.9-1.2 1.7 1.7-1.2 1.9c.3.5.6 1 .8 1.6l2.2.5v2.4l-2.2.5c-.2.6-.5 1.1-.8 1.6l1.2 1.9-1.7 1.7-1.9-1.2c-.5.3-1 .6-1.6.8l-.5 2.2h-2.4l-.5-2.2a7.8 7.8 0 0 1-1.6-.8l-1.9 1.2-1.7-1.7 1.2-1.9a7.8 7.8 0 0 1-.8-1.6l-2.2-.5V10l2.2-.5c.2-.6.5-1.1.8-1.6L4.2 6l1.7-1.7 1.9 1.2c.5-.3 1-.6 1.6-.7l.5-2.3Zm1.2 6a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
                    </svg>
                  </button>
                </div>
                {randomParamsOpen ? (
                  <>
                    <div className="random-param-row">
                      <label htmlFor="random-m-count">Number of M:</label>
                      <input
                        id="random-m-count"
                        type="number"
                        min={0}
                        max={48}
                        step={1}
                        value={randomAssignmentSettings.M}
                        onChange={(event) => updateRandomAssignmentCount('M', event.target.value)}
                        disabled={designLocked}
                      />
                    </div>
                    <div className="random-param-row">
                      <label htmlFor="random-z-count">Number of Z:</label>
                      <input
                        id="random-z-count"
                        type="number"
                        min={0}
                        max={48}
                        step={1}
                        value={randomAssignmentSettings.Z}
                        onChange={(event) => updateRandomAssignmentCount('Z', event.target.value)}
                        disabled={designLocked}
                      />
                    </div>
                    <div className="random-param-row">
                      <label htmlFor="random-r-count">Number of R:</label>
                      <input
                        id="random-r-count"
                        type="number"
                        min={0}
                        max={48}
                        step={1}
                        value={randomAssignmentSettings.R}
                        onChange={(event) => updateRandomAssignmentCount('R', event.target.value)}
                        disabled={designLocked}
                      />
                    </div>
                    <div className="random-param-row">
                      <label htmlFor="random-max-controls-column">Max controls per column:</label>
                      <input
                        id="random-max-controls-column"
                        type="number"
                        min={1}
                        max={8}
                        step={1}
                        value={randomAssignmentSettings.maxControlsPerColumn}
                        onChange={(event) => updateMaxControlsPerColumn(event.target.value)}
                        disabled={designLocked}
                      />
                    </div>
                    <div className="random-param-note">Applies to any R, Z and M.</div>
                    <label className="random-param-check">
                      <input
                        type="checkbox"
                        checked={randomAssignmentSettings.sustainabilityMode}
                        onChange={(event) =>
                          setRandomAssignmentSettings((prev) => ({
                            ...prev,
                            sustainabilityMode: event.target.checked
                          }))
                        }
                        disabled={designLocked}
                      />
                      <span>
                        Sustainability mode
                        <small>
                          Forces all R&apos;s to be placed in the same row for the entire plate
                        </small>
                      </span>
                    </label>
                  </>
                ) : null}
              </div>
              <button
                type="button"
                className={`sample-button lock-button ${designLocked ? 'active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setDesignLocked((prev) => !prev);
                }}
              >
                {designLocked ? 'Unlock design' : 'Lock design'}
              </button>
              <div className="filter-hint">
                {designLocked
                  ? 'Design is locked. Unlock to edit.'
                  : 'Click or drag wells to select, then assign a sample type.'}
              </div>
            </aside>
            <div className="design-panels">
              {visiblePlateIndexes.map((index) => {
                const plate = designPlates[index];
                if (!plate) {
                  return null;
                }
                return (
                <div key={`plate-${index}`} className={`plate-card ${collapsedPlates[index] ? 'collapsed' : ''}`}>
                  <div className="plate-header">
                    <div
                      className="plate-header-main"
                      onClick={() => togglePlateCollapsed(index)}
                    >
                      <div className="plate-title-text">
                        {plate.label || formatPlateDisplayLabel(index, plateBatchIds[index] ?? '')}
                      </div>
                      <div className="plate-header-tools">
                        <button
                          type="button"
                          className="secondary plate-export-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleExportDesignPlateCsv(index);
                          }}
                          title="Export plate configuration as CSV"
                        >
                          Export CSV
                        </button>
                        <div className="plate-tags">
                          {(() => {
                            const counts = sampleCounts(plate);
                            return SAMPLE_OPTIONS.map((option) => (
                              <span
                                key={`tag-${index}-${option.type}`}
                                className={`plate-tag sample-${option.type}`}
                              >
                                {option.type} {counts[option.type]}
                              </span>
                            ));
                          })()}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`plate-collapse-toggle ${collapsedPlates[index] ? '' : 'expanded'}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePlateCollapsed(index);
                      }}
                      aria-label={collapsedPlates[index] ? 'Expand plate' : 'Collapse plate'}
                      title={collapsedPlates[index] ? 'Expand plate' : 'Collapse plate'}
                    >
                      ▾
                    </button>
                  </div>
                  {collapsedPlates[index] ? null : (
                    <div className="plate-scroll">
                      <table className="plate">
                        <thead>
                          <tr>
                            <th className="corner" />
                            {!isPlateSplit(index) ? (
                              <th colSpan={12}>
                                <div className="plate-header-label">
                                  {plate.leftName || 'Unassigned cryosection'}
                                </div>
                              </th>
                            ) : (
                              <>
                                <th colSpan={6} className="plate-divider">
                                  <div className="plate-header-label">
                                    {plate.leftName || 'Unassigned cryosection'}
                                  </div>
                                </th>
                                <th colSpan={6}>
                                  <div className="plate-header-label">
                                    {plate.rightName || 'Unassigned cryosection'}
                                  </div>
                                </th>
                              </>
                            )}
                          </tr>
                          <tr>
                            <th className="corner" />
                            {PLATE_COLS.map((col) => (
                              <th
                                key={`col-${col}`}
                                className={
                                  isPlateSplit(index) && col === 6
                                    ? 'plate-divider'
                                    : undefined
                                }
                              >
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {PLATE_ROWS.map((row, rowIndex) => (
                            <tr key={`row-${row}`}>
                              <th className="row-label">{row}</th>
                              {PLATE_COLS.map((col, colIndex) => {
                                const cellKey = `${index}:${rowIndex}:${colIndex}`;
                                const cellType = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
                                const isSelected = selectedPlateCells.has(cellKey);
                                return (
                                  <td
                                    key={`cell-${row}-${col}`}
                                    className={`plate-cell sample-${cellType} ${
                                      isSelected ? 'selected' : ''
                                    } ${
                                      isPlateSplit(index) && col === 6
                                        ? 'plate-divider'
                                        : ''
                                    }`}
                                    role="button"
                                    tabIndex={0}
                                    onMouseDown={(event) =>
                                      handlePlateCellMouseDown(event, index, rowIndex, colIndex)
                                    }
                                    onMouseEnter={() =>
                                      handlePlateCellMouseEnter(index, rowIndex, colIndex)
                                    }
                                    onMouseUp={(event) => {
                                      event.stopPropagation();
                                      endPlateSelectionDrag();
                                    }}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    {cellType}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="plate-notes-row">
                        <label htmlFor={`plate-notes-${index}`} className="plate-notes-label">
                          NOTES:
                        </label>
                        <input
                          id={`plate-notes-${index}`}
                          type="text"
                          className="plate-notes-input"
                          value={plate.notes}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={(event) => event.stopPropagation()}
                          onChange={(event) => updatePlate(index, 'notes', event.target.value)}
                          disabled={designLocked}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )})}
            </div>
          </section>
        ) : activeTab === 'metadata' ? (
          <section className="metadata-layout">
            <aside className="sidebar metadata-sidebar">
              <div className="sidebar-header">
                <div>
                  <div className="app-title">Metadata</div>
                  <div className="app-subtitle">Plate table view</div>
                </div>
              </div>

              <div className="search-row metadata-search-row">
                <input
                  ref={metadataSearchRef}
                  type="text"
                  placeholder="Search wells, plates..."
                  value={metadataSearch}
                  onChange={(event) => setMetadataSearch(event.target.value)}
                />
                <select
                  id="metadata-search-scope"
                  className="search-scope-select"
                  value={metadataSearchScope}
                  onChange={(event) =>
                    setMetadataSearchScope(event.target.value as MetadataSearchScope)
                  }
                >
                  <option value="all">All columns</option>
                  {allMetadataColumns.map((column) => (
                    <option key={`metadata-search-scope-${column.key}`} value={column.key}>
                      {column.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="metadata-columns-wrap">
                <button
                  ref={metadataColumnsButtonRef}
                  type="button"
                  className="secondary metadata-columns-button"
                  onClick={() => {
                    setMetadataColumnsPopupOpen((prev) => !prev);
                    setMetadataFiltersPopupOpen(false);
                    setMetadataExportPopupOpen(false);
                  }}
                >
                  Columns
                </button>
                {metadataColumnsPopupOpen ? (
                  <div ref={metadataColumnsPopupRef} className="metadata-columns-popup">
                    {orderedBaseMetadataColumns.map((column) => (
                      <div
                        key={`metadata-col-${column.key}`}
                        className={`metadata-column-item ${
                          draggedMetadataColumnKey === column.key ? 'dragging' : ''
                        }`}
                        draggable
                        onDragStart={() => setDraggedMetadataColumnKey(column.key)}
                        onDragEnd={() => setDraggedMetadataColumnKey(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (draggedMetadataColumnKey) {
                            reorderMetadataColumns(draggedMetadataColumnKey, column.key);
                          }
                          setDraggedMetadataColumnKey(null);
                        }}
                      >
                        <span className="metadata-column-handle" aria-hidden>
                          ⋮⋮
                        </span>
                        <label className="filter-row">
                          <input
                            type="checkbox"
                            checked={metadataColumns[column.key as MetadataColumnKey]}
                            onChange={(event) =>
                              setMetadataColumns((prev) => ({
                                ...prev,
                                [column.key]: event.target.checked
                              }))
                            }
                          />
                          <span>{column.label}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="metadata-filters-wrap">
                <button
                  ref={metadataFiltersButtonRef}
                  type="button"
                  className="secondary metadata-filters-button"
                  onClick={() => {
                    setMetadataFiltersPopupOpen((prev) => !prev);
                    setMetadataColumnsPopupOpen(false);
                    setMetadataExportPopupOpen(false);
                  }}
                >
                  Filter
                </button>
                {metadataFiltersPopupOpen ? (
                  <div ref={metadataFiltersPopupRef} className="metadata-filters-popup">
                    <div className="filter-box">
                      <div className="control-title">Plates</div>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={metadataPlate1}
                          onChange={(event) => setMetadataPlate1(event.target.checked)}
                        />
                        <span>{designPlates[0]?.label || 'Plate 1'}</span>
                      </label>
                      {isSinglePlateProject ? null : (
                        <label className="filter-row">
                          <input
                            type="checkbox"
                            checked={metadataPlate2}
                            onChange={(event) => setMetadataPlate2(event.target.checked)}
                          />
                          <span>{designPlates[1]?.label || 'Plate 2'}</span>
                        </label>
                      )}
                    </div>
                    <div className="filter-box">
                      <div className="control-title">Cryosection</div>
                      {assignedCryosectionIndexes.map((cryoIndex) => (
                        <label key={`metadata-cryo-filter-${cryoIndex}`} className="filter-row">
                          <input
                            type="checkbox"
                            checked={metadataCryoFilters[cryoIndex] !== false}
                            onChange={(event) =>
                              setMetadataCryoFilters((prev) =>
                                replaceAt(prev, cryoIndex, event.target.checked)
                              )
                            }
                          />
                          <span>
                            {getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="filter-box">
                      <div className="control-title">Sample Type</div>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={metadataP}
                          onChange={(event) => setMetadataP(event.target.checked)}
                        />
                        <span>Positive (P)</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={metadataM}
                          onChange={(event) => setMetadataM(event.target.checked)}
                        />
                        <span>Membrane (M)</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={metadataZ}
                          onChange={(event) => setMetadataZ(event.target.checked)}
                        />
                        <span>Lysis (Z)</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={metadataR}
                          onChange={(event) => setMetadataR(event.target.checked)}
                        />
                        <span>Reaction (R)</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={metadataN}
                          onChange={(event) => setMetadataN(event.target.checked)}
                        />
                        <span>Not used (N)</span>
                      </label>
                    </div>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="secondary metadata-export-button"
                onClick={openMetadataExportPopup}
              >
                Export CSV
              </button>
            </aside>

            <div className="metadata-card">
              {errorBanner ? (
                <div className="main-alert error">{errorBanner}</div>
              ) : controlCoordinateIssues > 0 || positiveMissingCoordinates > 0 ? (
                <div className="main-alert error">
                  {controlCoordinateIssues > 0
                    ? `${controlCoordinateIssues} R/Z control wells contain coordinates. `
                    : ''}
                  {positiveMissingCoordinates > 0
                    ? `${positiveMissingCoordinates} positive samples are missing coordinates.`
                    : ''}
                </div>
              ) : null}
              <div className="metadata-table-wrap">
                <table className="metadata-table">
                  <thead>
                    <tr>
                      {visibleMetadataColumns.map((column) => (
                        <th key={`metadata-head-${column.key}`}>{column.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMetadataRows.map((row, index) => (
                      <tr
                        key={row.key}
                        className={[
                          index % 8 === 7 ? 'block-sep' : '',
                          `meta-${row.sample}`
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {visibleMetadataColumns.map((column) => {
                          if (isContourNameColumnKey(column.key)) {
                            const value = row.contourDistances?.[column.key];
                            return (
                              <td key={`${row.key}-${column.key}`}>
                                {value !== undefined ? formatNumber(value, 2) : '—'}
                              </td>
                            );
                          }
                          switch (column.key) {
                            case 'status': {
                              const statusSymbol =
                                row.coordStatus === 'ok'
                                  ? '✓'
                                  : row.coordStatus === 'warn'
                                    ? '⚠'
                                    : row.coordStatus === 'bad'
                                      ? '✕'
                                      : '—';
                              const hasLinkedData =
                                row.images.trim().length > 0 ||
                                row.pixelX !== undefined ||
                                row.pixelY !== undefined ||
                                row.xCoord !== undefined ||
                                row.yCoord !== undefined;
                              const statusTitle =
                                row.manualAssigned
                                  ? 'Coordinates were linked manually. Click for actions.'
                                  : row.inferred && !row.inferenceConfirmed
                                  ? 'Coordinates were inferred from LIF image order. Click for actions.'
                                  : row.coordStatus === 'ok'
                                    ? hasLinkedData
                                      ? 'Coordinates match expectations. Click for link actions.'
                                      : 'Coordinates match expectations'
                                    : row.coordStatus === 'warn'
                                      ? hasLinkedData
                                        ? 'Warning state. Click for link actions.'
                                        : 'R/Z controls contain collection data'
                                      : row.coordStatus === 'bad'
                                        ? hasLinkedData
                                          ? 'Coordinate mismatch. Click for link actions.'
                                          : 'Coordinate mismatch'
                                        : hasLinkedData
                                          ? 'Coordinates not calculated. Click for link actions.'
                                          : 'Coordinates not calculated';
                              if (hasLinkedData) {
                                return (
                                  <td key={`${row.key}-${column.key}`}>
                                    <button
                                      type="button"
                                      className={`coord-indicator ${row.coordStatus} actionable`}
                                      title={statusTitle}
                                      onClick={() =>
                                        openStatusPrompt({
                                          plateIndex: row.plateIndex,
                                          rowIndex: row.rowIndex,
                                          colIndex: row.colIndex,
                                          cryoIndex: row.cryoIndex,
                                          well: row.well,
                                          code: row.code,
                                          images: row.images,
                                          pixelX: row.pixelX,
                                          pixelY: row.pixelY,
                                          xCoord: row.xCoord,
                                          yCoord: row.yCoord,
                                          inferred: row.inferred,
                                          inferenceConfirmed: row.inferenceConfirmed,
                                          manualAssigned: row.manualAssigned,
                                          coordStatus: row.coordStatus
                                        })
                                      }
                                    >
                                      {statusSymbol}
                                    </button>
                                  </td>
                                );
                              }
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  <span
                                    className={`coord-indicator ${row.coordStatus}`}
                                    title={statusTitle}
                                  >
                                    {statusSymbol}
                                  </span>
                                </td>
                              );
                            }
                            case 'well':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  {row.coordStatus === 'bad' ? (
                                    <button
                                      type="button"
                                      className="metadata-well-link"
                                      title={`Open Coordinates and focus orphan images for collector ${PLATE_ROWS[row.rowIndex]}`}
                                      onClick={() => openMetadataRowOrphanAssignment(row)}
                                    >
                                      {formatWellDisplay(row.well)}
                                    </button>
                                  ) : (
                                    formatWellDisplay(row.well)
                                  )}
                                </td>
                              );
                            case 'plate':
                              return <td key={`${row.key}-${column.key}`}>{row.plateLabel}</td>;
                            case 'batch':
                              return <td key={`${row.key}-${column.key}`}>{row.batch || '—'}</td>;
                            case 'cryosection':
                              return <td key={`${row.key}-${column.key}`}>{row.halfLabel || '—'}</td>;
                            case 'sampleType':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  <span className={`sample-tag sample-${row.sample}`}>{row.sample}</span>
                                </td>
                              );
                            case 'microsample':
                              return <td key={`${row.key}-${column.key}`}>{row.code || '—'}</td>;
                            case 'number':
                              return <td key={`${row.key}-${column.key}`}>{row.number || '—'}</td>;
                            case 'shape':
                              return <td key={`${row.key}-${column.key}`}>{row.shape || '—'}</td>;
                            case 'collection':
                              return (
                                <td key={`${row.key}-${column.key}`}>{row.collection || '—'}</td>
                              );
                            case 'collectionMethod':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  {row.collectionMethod || COLLECTION_METHOD_OPTIONS[0]}
                                </td>
                              );
                            case 'images':
                              return <td key={`${row.key}-${column.key}`}>{row.images || '—'}</td>;
                            case 'pixelx':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  {row.pixelX !== undefined ? formatNumber(row.pixelX, 0) : '—'}
                                </td>
                              );
                            case 'pixely':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  {row.pixelY !== undefined ? formatNumber(row.pixelY, 0) : '—'}
                                </td>
                              );
                            case 'xcoord':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  {row.xCoord !== undefined ? formatNumber(row.xCoord, 2) : '—'}
                                </td>
                              );
                            case 'ycoord':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  {row.yCoord !== undefined ? formatNumber(row.yCoord, 2) : '—'}
                                </td>
                              );
                            case 'size':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  {row.size !== undefined ? formatNumber(row.size, 2) : '—'}
                                </td>
                              );
                            case 'notes':
                              return (
                                <td key={`${row.key}-${column.key}`}>
                                  <input
                                    className="notes-input"
                                    type="text"
                                    value={row.notes}
                                    onChange={(event) =>
                                      updateMetadataNote(
                                        `${row.plateIndex}-${row.rowIndex}-${row.colIndex}`,
                                        event.target.value
                                      )
                                    }
                                  />
                                </td>
                              );
                            default:
                              return null;
                          }
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : activeTab === 'collection' ? (
          <section className="collection-layout">
            <aside className="design-sidebar">
              <div className="control-title">Collection</div>
              <div className="filter-hint">
                Click left/right halves to increment. Right-click to decrement.
              </div>
              <div className="collection-meta-box">
                <div className="control-title">Import</div>
                <button type="button" className="secondary" onClick={handleImportCollectionCsv}>
                  Import collection CSV
                </button>
                <div className="filter-hint">
                  Required columns: Plate/LMBatch, Well/PlatePosition, Area/Size, Collection/Notes Collection
                </div>
              </div>
              <div className="collection-lock-box">
                <button
                  type="button"
                  className={`sample-button lock-button ${collectionPlateLocks[0] ? 'active' : ''}`}
                  onClick={() =>
                    setCollectionPlateLocks((prev) => [!prev[0], prev[1]])
                  }
                >
                  {collectionPlateLocks[0]
                    ? `Unlock ${designPlates[0]?.label || 'Plate 1'}`
                    : `Lock ${designPlates[0]?.label || 'Plate 1'}`}
                </button>
                {isSinglePlateProject ? null : (
                  <button
                    type="button"
                    className={`sample-button lock-button ${collectionPlateLocks[1] ? 'active' : ''}`}
                    onClick={() =>
                      setCollectionPlateLocks((prev) => [prev[0], !prev[1]])
                    }
                  >
                    {collectionPlateLocks[1]
                      ? `Unlock ${designPlates[1]?.label || 'Plate 2'}`
                      : `Lock ${designPlates[1]?.label || 'Plate 2'}`}
                  </button>
                )}
              </div>
              <div className="collection-meta-box">
                <div className="control-title">Collection Metadata</div>
                <label className="collection-meta-field">
                  <span>Collection method</span>
                  <select
                    value={collectionMetadata.collectionMethod}
                    onChange={(event) =>
                      updateCollectionMetadataField('collectionMethod', event.target.value)
                    }
                  >
                    {COLLECTION_METHOD_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="collection-meta-field">
                  <span>Date</span>
                  <input
                    type="date"
                    value={collectionMetadata.date}
                    onChange={(event) => updateCollectionMetadataField('date', event.target.value)}
                  />
                </label>
                <div className="collection-meta-inline-row">
                  <label className="collection-meta-field compact">
                    <span className="tooltip-label">
                      Start time
                      <span className="tooltip-bubble">
                        Automatically set when the first collection-related field is modified.
                        You can edit it manually to override.
                      </span>
                    </span>
                    <input
                      type="time"
                      step={1}
                      value={collectionMetadata.startTime}
                      onChange={(event) =>
                        updateCollectionTimeField('startTime', event.target.value)
                      }
                    />
                  </label>
                  <label className="collection-meta-field compact">
                    <span className="tooltip-label">
                      End time
                      <span className="tooltip-bubble">
                        Automatically updated on each collection-related change.
                        You can edit it manually to override.
                      </span>
                    </span>
                    <input
                      type="time"
                      step={1}
                      value={collectionMetadata.endTime}
                      onChange={(event) =>
                        updateCollectionTimeField('endTime', event.target.value)
                      }
                    />
                  </label>
                </div>
                <div className="collection-meta-inline-row">
                  <label className="collection-meta-field compact">
                    <span>Temperature</span>
                    <div className="collection-meta-unit-input">
                      <input
                        type="text"
                        value={collectionMetadata.temperature}
                        onChange={(event) =>
                          updateCollectionMetadataField('temperature', event.target.value)
                        }
                      />
                      <span className="collection-meta-unit">°C</span>
                    </div>
                  </label>
                  <label className="collection-meta-field compact">
                    <span>Humidity</span>
                    <div className="collection-meta-unit-input">
                      <input
                        type="text"
                        value={collectionMetadata.humidity}
                        onChange={(event) =>
                          updateCollectionMetadataField('humidity', event.target.value)
                        }
                      />
                      <span className="collection-meta-unit">%</span>
                    </div>
                  </label>
                </div>
                <label className="collection-meta-field">
                  <span>Notes</span>
                  <textarea
                    rows={4}
                    value={collectionMetadata.notes}
                    onChange={(event) =>
                      updateCollectionMetadataField('notes', event.target.value)
                    }
                  />
                </label>
              </div>
            </aside>
            <div className="collection-panels">
              {collectionAreaHint ? (
                <div className="collection-area-hint-overlay" role="status" aria-live="polite">
                  <div className="collection-area-hint-popup">{collectionAreaHint}</div>
                </div>
              ) : null}
              {visiblePlateIndexes.map((index) => {
                const plate = designPlates[index];
                if (!plate) {
                  return null;
                }
                const hasConsecutiveAreaDuplicate = PLATE_COLS.some((_, colIndex) =>
                  hasDuplicateCollectionArea(index, colIndex)
                );
                const collectionWarningForPlate =
                  collectionColumnWarning?.plateIndex === index
                    ? collectionColumnWarning.message
                    : null;
                return (
                <div key={`collection-${index}`} className={`plate-card ${collapsedPlates[index] ? 'collapsed' : ''}`}>
                  <div className="plate-header">
                    <div
                      className="plate-header-main"
                      onClick={() => togglePlateCollapsed(index)}
                    >
                      <div className="plate-title-text">
                        {plate.label || formatPlateDisplayLabel(index, plateBatchIds[index] ?? '')}
                      </div>
                      <div className="plate-tags">
                        {(() => {
                          const counts = sampleCounts(plate);
                          return SAMPLE_OPTIONS.map((option) => (
                            <span
                              key={`collection-tag-${index}-${option.type}`}
                              className={`plate-tag sample-${option.type}`}
                            >
                              {option.type} {counts[option.type]}
                            </span>
                          ));
                        })()}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`plate-collapse-toggle ${collapsedPlates[index] ? '' : 'expanded'}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePlateCollapsed(index);
                      }}
                      aria-label={collapsedPlates[index] ? 'Expand plate' : 'Collapse plate'}
                      title={collapsedPlates[index] ? 'Expand plate' : 'Collapse plate'}
                    >
                      ▾
                    </button>
                  </div>
                  {collapsedPlates[index] ? null : (
                  <div className="plate-scroll">
                    <table className="plate">
                      <thead>
                        <tr>
                          <th className="corner" />
                          {!isPlateSplit(index) ? (
                            <th colSpan={12}>
                              <div className="plate-header-label">
                                {plate.leftName || 'Unassigned cryosection'}
                              </div>
                            </th>
                          ) : (
                            <>
                              <th colSpan={6} className="plate-divider">
                                <div className="plate-header-label">
                                  {plate.leftName || 'Unassigned cryosection'}
                                </div>
                              </th>
                              <th colSpan={6}>
                                <div className="plate-header-label">
                                  {plate.rightName || 'Unassigned cryosection'}
                                </div>
                              </th>
                            </>
                          )}
                        </tr>
                        <tr>
                          <th className="corner" />
                          {PLATE_COLS.map((col) => (
                            <th
                              key={`collection-col-${col}`}
                              className={
                                isPlateSplit(index) && col === 6
                                  ? 'plate-divider'
                                  : undefined
                              }
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                        <tr>
                          <th className="corner area-row-label">Area</th>
                          {PLATE_COLS.map((col, colIndex) => {
                            const areaCode = collectionColumnAreas[index]?.[colIndex] ?? '';
                            const areaIsDuplicate = hasDuplicateCollectionArea(index, colIndex);
                            const areaDisabledByNotUsed = PLATE_ROWS.every((_, rowIndex) => {
                              const sample = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
                              return sample === DISABLED_SAMPLE;
                            });
                            const areaInputDisabled = areaDisabledByNotUsed;
                            return (
                              <th
                                key={`collection-area-input-${col}`}
                                className={
                                  isPlateSplit(index) && col === 6
                                    ? 'plate-divider'
                                    : undefined
                                }
                              >
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  maxLength={4}
                                  className={`collection-area-input ${areaIsDuplicate ? 'invalid' : ''}`}
                                  value={areaCode}
                                  onClick={(event) => event.stopPropagation()}
                                  onFocus={(event) => event.stopPropagation()}
                                  onChange={(event) =>
                                    updateCollectionColumnArea(index, colIndex, event.target.value)
                                  }
                                  disabled={areaInputDisabled}
                                  placeholder="0000"
                                  title={
                                    areaIsDuplicate
                                      ? 'Area must be different from the previous column.'
                                      : areaDisabledByNotUsed
                                        ? 'Disabled because all wells in this column are Not used.'
                                      : undefined
                                  }
                                />
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {PLATE_ROWS.map((row, rowIndex) => (
                          <tr key={`collection-row-${row}`}>
                            <th className="row-label">{row}</th>
                            {PLATE_COLS.map((col, colIndex) => {
                              const sample = plate.cells[rowIndex]?.[colIndex] ?? DEFAULT_SAMPLE;
                              const areaCode = collectionColumnAreas[index]?.[colIndex] ?? '';
                              const areaMissing = areaCode.length !== 4;
                              const areaIsDuplicate = hasDuplicateCollectionArea(index, colIndex);
                              const sampleDisabled = sample === DISABLED_SAMPLE;
                              const columnLocked =
                                collectionPlateLocks[index] ||
                                areaMissing ||
                                areaIsDuplicate ||
                                sampleDisabled;
                              const counts =
                                collectionPlates[index]?.[rowIndex]?.[colIndex] ?? {
                                  left: 0,
                                  right: 0,
                                  rightTouched: false
                                };
                              return (
                                <td
                                  key={`collection-cell-${row}-${col}`}
                                  className={`collection-cell sample-${sample} ${
                                    columnLocked ? 'locked-col' : ''
                                  } ${
                                    isPlateSplit(index) && col === 6
                                      ? 'plate-divider'
                                      : ''
                                  }`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (!columnLocked) {
                                      setCollectionColumnWarning(null);
                                      return;
                                    }
                                    if (!collectionPlateLocks[index] && !sampleDisabled && areaMissing) {
                                      setCollectionColumnWarning({
                                        plateIndex: index,
                                        message:
                                          'This column is disabled: enter a 4-digit Area value to enable collection.'
                                      });
                                    }
                                  }}
                                >
                                  <div className="collection-split">
                                    <button
                                      type="button"
                                      className="collection-half"
                                      disabled={columnLocked}
                                      onClick={() => {
                                        markCollectionEdited();
                                        setCollectionPlates((prev) =>
                                          prev.map((plateRows, plateIndex) => {
                                            if (plateIndex !== index) {
                                              return plateRows;
                                            }
                                            return plateRows.map((rowCells, rowIdx) => {
                                              if (rowIdx !== rowIndex) {
                                                return rowCells;
                                              }
                                              return rowCells.map((cell, cellIdx) => {
                                                if (cellIdx !== colIndex) {
                                                  return cell;
                                                }
                                                return {
                                                  ...cell,
                                                  left: cell.left + 1
                                                };
                                              });
                                            });
                                          })
                                        );
                                      }}
                                      onContextMenu={(event) => {
                                        event.preventDefault();
                                        if (columnLocked) {
                                          return;
                                        }
                                        if (counts.left > 0) {
                                          markCollectionEdited();
                                        }
                                        setCollectionPlates((prev) =>
                                          prev.map((plateRows, plateIndex) => {
                                            if (plateIndex !== index) {
                                              return plateRows;
                                            }
                                            return plateRows.map((rowCells, rowIdx) => {
                                              if (rowIdx !== rowIndex) {
                                                return rowCells;
                                              }
                                              return rowCells.map((cell, cellIdx) => {
                                                if (cellIdx !== colIndex) {
                                                  return cell;
                                                }
                                                return {
                                                  ...cell,
                                                  left: Math.max(0, cell.left - 1)
                                                };
                                              });
                                            });
                                          })
                                        );
                                      }}
                                    >
                                      {counts.left === 0 ? '' : counts.left}
                                    </button>
                                    <button
                                      type="button"
                                      className="collection-half"
                                      disabled={columnLocked}
                                      onClick={() => {
                                        markCollectionEdited();
                                        setCollectionPlates((prev) =>
                                          prev.map((plateRows, plateIndex) => {
                                            if (plateIndex !== index) {
                                              return plateRows;
                                            }
                                            return plateRows.map((rowCells, rowIdx) => {
                                              if (rowIdx !== rowIndex) {
                                                return rowCells;
                                              }
                                              return rowCells.map((cell, cellIdx) => {
                                                if (cellIdx !== colIndex) {
                                                  return cell;
                                                }
                                                return {
                                                  ...cell,
                                                  right: nextCollectionRight(cell.right),
                                                  rightTouched: false
                                                };
                                              });
                                            });
                                          })
                                        );
                                      }}
                                      onContextMenu={(event) => {
                                        event.preventDefault();
                                        if (columnLocked) {
                                          return;
                                        }
                                        markCollectionEdited();
                                        setCollectionPlates((prev) =>
                                          prev.map((plateRows, plateIndex) => {
                                            if (plateIndex !== index) {
                                              return plateRows;
                                            }
                                            return plateRows.map((rowCells, rowIdx) => {
                                              if (rowIdx !== rowIndex) {
                                                return rowCells;
                                              }
                                              return rowCells.map((cell, cellIdx) => {
                                                if (cellIdx !== colIndex) {
                                                  return cell;
                                                }
                                                return {
                                                  ...cell,
                                                  right: prevCollectionRight(cell.right),
                                                  rightTouched: false
                                                };
                                              });
                                            });
                                          })
                                        );
                                      }}
                                    >
                                      {counts.right === 1 ? (
                                        <span className="collection-icon cross">✕</span>
                                      ) : counts.right > 1 ? (
                                        (() => {
                                          const checkCount = Math.min(3, counts.right - 1);
                                          const positions =
                                            checkCount === 1
                                              ? ['']
                                              : checkCount === 2
                                                ? ['stack-left5', 'stack-right5']
                                                : ['stack-left10', '', 'stack-right10'];
                                          return (
                                            <span className="collection-icon-stack" aria-hidden>
                                              {positions.map((positionClass, positionIndex) => (
                                                <span
                                                  key={`check-${positionIndex}`}
                                                  className={`collection-icon check stacked ${positionClass}`.trim()}
                                                >
                                                  ✓
                                                </span>
                                              ))}
                                            </span>
                                          );
                                        })()
                                      ) : (
                                        ''
                                      )}
                                    </button>
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {hasConsecutiveAreaDuplicate || collectionWarningForPlate ? (
                      <div
                        className="collection-area-warning-tooltip"
                        role="alert"
                        aria-live="polite"
                      >
                        {hasConsecutiveAreaDuplicate
                          ? 'Two consecutive columns cannot have identical areas'
                          : collectionWarningForPlate}
                      </div>
                    ) : null}
                    <div className="plate-notes-row">
                      <label htmlFor={`collection-plate-notes-${index}`} className="plate-notes-label">
                        NOTES:
                      </label>
                      <input
                        id={`collection-plate-notes-${index}`}
                        type="text"
                        className="plate-notes-input"
                        value={collectionPlateNotes[index] ?? ''}
                        disabled={collectionPlateLocks[index]}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          setCollectionPlateNotes((prev) => {
                            const next: [string, string] = [prev[0], prev[1]];
                            if (next[index] !== event.target.value) {
                              markCollectionEdited();
                            }
                            next[index] = event.target.value;
                            return next;
                          })
                        }
                      />
                    </div>
                  </div>
                  )}
                </div>
              )})}
            </div>
          </section>
        ) : activeTab === 'overview' ? (
          <section className="overview-layout">
            <div className="viewer-sidebar">
              <div className="cryo-selector-box">
                <span className="control-title">Cryosection</span>
                <div ref={overviewCryosectionMenuRef} className="cryo-selector-control">
                  <button
                    type="button"
                    className={`cryo-selector-trigger ${
                      overviewCryosectionMenuOpen ? 'open' : ''
                    }`}
                    onClick={() =>
                      setOverviewCryosectionMenuOpen((prev) => !prev)
                    }
                    aria-expanded={overviewCryosectionMenuOpen}
                  >
                    <span>
                      {getCryosectionName(activeCryosection) ||
                        `Cryosection ${activeCryosection + 1}`}
                    </span>
                    <span className="cryo-selector-caret" aria-hidden>
                      ▾
                    </span>
                  </button>
                  {overviewCryosectionMenuOpen ? (
                    <div className="cryo-selector-menu">
                      {selectableCryosectionIndexes.map((cryoIndex) => (
                        <button
                          key={`overview-cryo-option-${cryoIndex}`}
                          type="button"
                          className={`cryo-selector-option ${
                            activeCryosection === cryoIndex ? 'active' : ''
                          }`}
                          onClick={() => {
                            setActiveCryosection(cryoIndex);
                            setOverviewCryosectionMenuOpen(false);
                          }}
                        >
                          {getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              <aside className="sidebar">
                <div className="sidebar-header">
                  <div>
                    <div className="app-title">Overview</div>
                    <div className="app-subtitle">Slide alignment workspace</div>
                  </div>
                </div>
                <div className="button-row">
                  <button
                    className={`secondary ${overview.activeLayer === 'pre' ? 'active' : ''}`}
                    onClick={() => handleOpenOverviewImage('pre')}
                  >
                    Load pre-cut overview
                  </button>
                  <button
                    className={`secondary ${overview.activeLayer === 'post' ? 'active' : ''}`}
                    onClick={() => handleOpenOverviewImage('post')}
                  >
                    Load post-cut overview
                  </button>
                </div>
                <label className="filter-row">
                  <input
                    type="checkbox"
                    checked={overview.linked}
                    onChange={(event) => setOverviewLinked(event.target.checked)}
                  />
                  <span>Link pre/post transforms</span>
                </label>
                <div className={`filter-box ${overviewVisibilityCollapsed ? 'collapsed' : ''}`}>
                  <button
                    type="button"
                    className="collapsible-title-btn"
                    onClick={() => setOverviewVisibilityCollapsed((prev) => !prev)}
                    aria-expanded={!overviewVisibilityCollapsed}
                  >
                    <span className="control-title">Visibility</span>
                    <span
                      className={`collapsible-caret ${overviewVisibilityCollapsed ? '' : 'expanded'}`}
                      aria-hidden
                    >
                      ▾
                    </span>
                  </button>
                  {overviewVisibilityCollapsed ? null : (
                    <>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={overview.showCutPoints}
                          onChange={(event) =>
                            setOverviewState((state) => {
                              state.showCutPoints = event.target.checked;
                              return state;
                            })
                          }
                        />
                        <span>Cut points</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={overview.showOrphanImages}
                          onChange={(event) =>
                            setOverviewState((state) => {
                              state.showOrphanImages = event.target.checked;
                              return state;
                            })
                          }
                        />
                        <span>Orphan images</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={overview.showCutImages}
                          onChange={(event) =>
                            setOverviewState((state) => {
                              state.showCutImages = event.target.checked;
                              return state;
                            })
                          }
                        />
                        <span>Cut images</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={overview.showMembraneControls}
                          onChange={(event) =>
                            setOverviewState((state) => {
                              state.showMembraneControls = event.target.checked;
                              return state;
                            })
                          }
                        />
                        <span>Membrane controls</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={overview.showPre}
                          onChange={(event) =>
                            setOverviewState((state) => {
                              state.showPre = event.target.checked;
                              return state;
                            })
                          }
                        />
                        <span>Overview pre-cut</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={overview.showPost}
                          onChange={(event) =>
                            setOverviewState((state) => {
                              state.showPost = event.target.checked;
                              return state;
                            })
                          }
                        />
                        <span>Overview post-cut</span>
                      </label>
                    </>
                  )}
                </div>
                <div className={`control-box ${overviewAlignmentCollapsed ? 'collapsed' : ''}`}>
                  <button
                    type="button"
                    className="collapsible-title-btn"
                    onClick={() => setOverviewAlignmentCollapsed((prev) => !prev)}
                    aria-expanded={!overviewAlignmentCollapsed}
                  >
                    <span className="control-title">Image alignment</span>
                    <span
                      className={`collapsible-caret ${overviewAlignmentCollapsed ? '' : 'expanded'}`}
                      aria-hidden
                    >
                      ▾
                    </span>
                  </button>
                  {overviewAlignmentCollapsed ? null : (
                    <>
                  <label className="control-row">
                    <span>Scale X</span>
                    <input
                      type="range"
                      min={0.4}
                      max={1.6}
                      step={0.01}
                      value={activeOverviewLayer.scaleX}
                      onChange={(event) =>
                        updateOverviewLayer(overview.activeLayer, (layer) => ({
                          ...layer,
                          scaleX: clampValue(Number(event.target.value), 0.4, 1.6)
                        }))
                      }
                    />
                    <div className="stepper">
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewScale('x', -0.01)}
                      >
                        -
                      </button>
                      <input
                        type="number"
                        className="stepper-input"
                        min={0.4}
                        max={1.6}
                        step={0.01}
                        value={overviewAlignmentDrafts.scaleX}
                        onFocus={() => setEditingOverviewAlignmentField('scaleX')}
                        onChange={(event) =>
                          updateOverviewAlignmentDraft('scaleX', event.target.value)
                        }
                        onBlur={() => {
                          commitOverviewAlignmentDraft('scaleX');
                          setEditingOverviewAlignmentField(null);
                        }}
                        onKeyDown={(event) =>
                          handleOverviewAlignmentInputKeyDown(event, 'scaleX')
                        }
                      />
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewScale('x', 0.01)}
                      >
                        +
                      </button>
                    </div>
                  </label>
                  <label className="control-row">
                    <span>Scale Y</span>
                    <input
                      type="range"
                      min={0.4}
                      max={1.6}
                      step={0.01}
                      value={activeOverviewLayer.scaleY}
                      onChange={(event) =>
                        updateOverviewLayer(overview.activeLayer, (layer) => ({
                          ...layer,
                          scaleY: clampValue(Number(event.target.value), 0.4, 1.6)
                        }))
                      }
                    />
                    <div className="stepper">
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewScale('y', -0.01)}
                      >
                        -
                      </button>
                      <input
                        type="number"
                        className="stepper-input"
                        min={0.4}
                        max={1.6}
                        step={0.01}
                        value={overviewAlignmentDrafts.scaleY}
                        onFocus={() => setEditingOverviewAlignmentField('scaleY')}
                        onChange={(event) =>
                          updateOverviewAlignmentDraft('scaleY', event.target.value)
                        }
                        onBlur={() => {
                          commitOverviewAlignmentDraft('scaleY');
                          setEditingOverviewAlignmentField(null);
                        }}
                        onKeyDown={(event) =>
                          handleOverviewAlignmentInputKeyDown(event, 'scaleY')
                        }
                      />
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewScale('y', 0.01)}
                      >
                        +
                      </button>
                    </div>
                  </label>
                  <div className="control-row compact">
                    <span>Offset X</span>
                    <div className="stepper">
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewOffset('x', -10)}
                      >
                        -
                      </button>
                      <input
                        type="number"
                        className="stepper-input"
                        step={0.1}
                        value={overviewAlignmentDrafts.offsetX}
                        onFocus={() => setEditingOverviewAlignmentField('offsetX')}
                        onChange={(event) =>
                          updateOverviewAlignmentDraft('offsetX', event.target.value)
                        }
                        onBlur={() => {
                          commitOverviewAlignmentDraft('offsetX');
                          setEditingOverviewAlignmentField(null);
                        }}
                        onKeyDown={(event) =>
                          handleOverviewAlignmentInputKeyDown(event, 'offsetX')
                        }
                      />
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewOffset('x', 10)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="control-row compact">
                    <span>Offset Y</span>
                    <div className="stepper">
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewOffset('y', -10)}
                      >
                        -
                      </button>
                      <input
                        type="number"
                        className="stepper-input"
                        step={0.1}
                        value={overviewAlignmentDrafts.offsetY}
                        onFocus={() => setEditingOverviewAlignmentField('offsetY')}
                        onChange={(event) =>
                          updateOverviewAlignmentDraft('offsetY', event.target.value)
                        }
                        onBlur={() => {
                          commitOverviewAlignmentDraft('offsetY');
                          setEditingOverviewAlignmentField(null);
                        }}
                        onKeyDown={(event) =>
                          handleOverviewAlignmentInputKeyDown(event, 'offsetY')
                        }
                      />
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => nudgeOverviewOffset('y', 10)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="control-hint">
                    Drag the overview image to move. Hold Alt and scroll to scale.
                  </div>
                  <div className="alignment-import-row">
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        overviewAlignmentImportSource === null ||
                        overviewAlignmentImportOptions.length === 0
                      }
                      onClick={importOverviewAlignmentFromCryosection}
                    >
                      Import from
                    </button>
                    <select
                      className="alignment-import-select"
                      value={overviewAlignmentImportSource ?? ''}
                      onChange={(event) =>
                        setOverviewAlignmentImportSource(
                          event.target.value === '' ? null : Number(event.target.value)
                        )
                      }
                      disabled={overviewAlignmentImportOptions.length === 0}
                    >
                      {overviewAlignmentImportOptions.length === 0 ? (
                        <option value="">No other cryosections</option>
                      ) : (
                        overviewAlignmentImportOptions.map((cryoIndex) => (
                          <option key={`overview-import-${cryoIndex}`} value={cryoIndex}>
                            {getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                    </>
                  )}
                </div>
                <div className={`control-box ${overviewContourCollapsed ? 'collapsed' : ''}`}>
                  <button
                    type="button"
                    className="collapsible-title-btn"
                    onClick={() => setOverviewContourCollapsed((prev) => !prev)}
                    aria-expanded={!overviewContourCollapsed}
                  >
                    <span className="control-title">Contour</span>
                    <span
                      className={`collapsible-caret ${overviewContourCollapsed ? '' : 'expanded'}`}
                      aria-hidden
                    >
                      ▾
                    </span>
                  </button>
                  {overviewContourCollapsed ? null : (
                    <>
                      <button
                        type="button"
                        className={`secondary ${activeOverviewContourId ? 'active' : ''}`}
                        onClick={() =>
                          activeOverviewContourId ? finishOverviewContour() : startOverviewContour()
                        }
                      >
                        {activeOverviewContourId ? 'Finish contour' : 'New contour'}
                      </button>
                      <div className="filter-hint">
                        Left-click to add nodes. Double-click or Finish to stop drawing.
                      </div>
                      <div className="contour-list">
                        {overviewContours.length === 0 ? (
                          <div className="filter-hint">No contours.</div>
                        ) : (
                          overviewContours.map((contour, contourIndex) => (
                            <div key={contour.id} className="contour-row">
                              <div className="contour-row-head">
                                <span
                                  className="contour-color-dot"
                                  style={{ backgroundColor: contour.color }}
                                  aria-hidden
                                />
                                <input
                                  type="text"
                                  value={contour.name}
                                  className="contour-name-input"
                                  onChange={(event) =>
                                    updateOverviewContours((contours) =>
                                      contours.map((item) =>
                                        item.id === contour.id
                                          ? {
                                              ...item,
                                              name:
                                                event.target.value ||
                                                getDefaultContourName(contourIndex)
                                            }
                                          : item
                                      )
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  className="secondary contour-delete-btn"
                                  onClick={() => removeOverviewContour(contour.id)}
                                >
                                  ✕
                                </button>
                              </div>
                              <div className="contour-row-controls">
                                <label className="filter-row">
                                  <input
                                    type="checkbox"
                                    checked={contour.visible}
                                    onChange={(event) =>
                                      updateOverviewContours((contours) =>
                                        contours.map((item) =>
                                          item.id === contour.id
                                            ? { ...item, visible: event.target.checked }
                                            : item
                                        )
                                      )
                                    }
                                  />
                                  <span>Show</span>
                                </label>
                                <label className="filter-row">
                                  <input
                                    type="checkbox"
                                    checked={contour.closed}
                                    onChange={(event) =>
                                      updateOverviewContours((contours) =>
                                        contours.map((item) =>
                                          item.id === contour.id
                                            ? { ...item, closed: event.target.checked }
                                            : item
                                        )
                                      )
                                    }
                                  />
                                  <span>Closed</span>
                                </label>
                                <button
                                  type="button"
                                  className={`secondary ${
                                    activeOverviewContourId === contour.id ? 'active' : ''
                                  }`}
                                  onClick={() =>
                                    setActiveOverviewContour(
                                      activeOverviewContourId === contour.id ? null : contour.id
                                    )
                                  }
                                >
                                  {activeOverviewContourId === contour.id ? 'Stop edit' : 'Edit'}
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              </aside>
            </div>
            <main className="main">
              {!stagePosition ? (
                <div className="main-alert error">
                  Select a stage position in Session to align the overview image.
                </div>
              ) : null}
              <section className="map" ref={overviewContainerRef} onWheel={handleOverviewWheel}>
                <canvas
                  ref={overviewCanvasRef}
                  onPointerDown={handleOverviewPointerDown}
                  onPointerMove={handleOverviewPointerMove}
                  onPointerUp={handleOverviewPointerUp}
                  onPointerLeave={handleOverviewPointerLeave}
                  onDoubleClick={handleOverviewDoubleClick}
                  onWheel={handleOverviewWheel}
                  onContextMenu={(event) => event.preventDefault()}
                />
              </section>
            </main>
            <aside className="viewer-sidebar right">
              <div className="sidebar right-sidebar">
                <div className="sidebar-header">
                  <div>
                    <div className="app-title">Selection</div>
                  </div>
                </div>
                <div className="selection-tools">
                  <div className="control-title">Aspect ratio</div>
                  <div className="aspect-grid">
                    {OVERVIEW_ASPECTS.map((option) => (
                      <button
                        key={`aspect-${option.label}`}
                        type="button"
                        className={`secondary ${
                          overviewSelection.aspect === option.value ? 'active' : ''
                        }`}
                        onClick={() => setOverviewSelectionAspect(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={overviewSelection.enabled ? 'secondary active' : 'secondary'}
                    onClick={() => setOverviewSelectionEnabled(!overviewSelection.enabled)}
                  >
                    {overviewSelection.enabled
                      ? 'Exit crop edit'
                      : overviewSelection.rect
                        ? 'Edit crop box'
                        : 'Create crop box'}
                  </button>
                  <div className="size-grid">
                    <div className="size-col-header"></div>
                    <div className="size-col-header">Viewer</div>
                    <div className="size-col-header">Output</div>

                    <div className="size-row-label">Width (px)</div>
                    <input
                      className="size-input"
                      type="number"
                      min="1"
                      step="0.1"
                      value={
                        overviewSelectionSizePx ? Number(overviewSelectionSizePx.w.toFixed(1)) : ''
                      }
                      disabled={!overviewSelectionSizePx}
                      onChange={(event) =>
                        updateOverviewSelectionPixelSize('w', Number(event.target.value))
                      }
                    />
                    <input
                      className="size-input"
                      type="number"
                      min="1"
                      step="1"
                      value={
                        (overviewExport ?? getDefaultExportSize())
                          ? Math.round((overviewExport ?? getDefaultExportSize()).w)
                          : ''
                      }
                      disabled={!overviewSelectionSizePx}
                      onChange={(event) =>
                        updateOverviewExportSize('w', Number(event.target.value))
                      }
                    />

                    <div className="size-row-label">Height (px)</div>
                    <input
                      className="size-input"
                      type="number"
                      min="1"
                      step="0.1"
                      value={
                        overviewSelectionSizePx ? Number(overviewSelectionSizePx.h.toFixed(1)) : ''
                      }
                      disabled={!overviewSelectionSizePx}
                      onChange={(event) =>
                        updateOverviewSelectionPixelSize('h', Number(event.target.value))
                      }
                    />
                    <input
                      className="size-input"
                      type="number"
                      min="1"
                      step="1"
                      value={
                        (overviewExport ?? getDefaultExportSize())
                          ? Math.round((overviewExport ?? getDefaultExportSize()).h)
                          : ''
                      }
                      disabled={!overviewSelectionSizePx}
                      onChange={(event) =>
                        updateOverviewExportSize('h', Number(event.target.value))
                      }
                    />
                  </div>
                  <div className="cutpoint-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setOverviewSelection((state) => ({ ...state, rect: null }));
                        setOverviewCropByCryo((prev) => {
                          const next: [OverviewCropResult, OverviewCropResult] = [
                            prev[0],
                            prev[1]
                          ];
                          next[activeCryosection] = {
                            rectPx: null,
                            cuts: [],
                            layer: prev[activeCryosection].layer
                          };
                          return next;
                        });
                        setOverviewExportByCryo((prev) => {
                          const next = prev.slice();
                          next[activeCryosection] = null;
                          return next;
                        });
                      }}
                    >
                      Remove box
                    </button>
                    <button type="button" className="secondary" onClick={computeOverviewCrop}>
                      Compute crop
                    </button>
                  </div>
                </div>
                <div className="selection-results">
                  <div className="crop-header-row">
                    <div className="control-title">Crop output</div>
                    <div className="crop-count">Cuts: {overviewCrop.cuts.length}</div>
                  </div>
                  {overviewCrop.cuts.length > 0 ? (
                    <div className="crop-cuts">
                      <div className="crop-header">
                        <span>Well</span>
                        <span>Microsample</span>
                        <span>Pixel X</span>
                        <span>Pixel Y</span>
                      </div>
                      {overviewCrop.cuts.map((cut) => (
                        <div key={`crop-${cut.id}`} className="crop-row">
                          <span>{formatWellDisplay(cut.well)}</span>
                          <span>{cut.code || '—'}</span>
                          <span>{formatNumber(cut.x, 1)}</span>
                          <span>{formatNumber(cut.y, 1)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="selection-results">
                  <div className="control-title">Export</div>
                  <div className="cutpoint-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={handleExportCropImage}
                    >
                      Export image
                    </button>
                    <button type="button" className="secondary" onClick={handleExportCropCsv}>
                      Export CSV
                    </button>
                  </div>
                </div>
              </div>
            </aside>
          </section>
        ) : (
          <div className="viewer-layout">
            <div className="viewer-sidebar">
              <div className="cryo-selector-box">
                <span className="control-title">Cryosection</span>
                <div ref={coordinatesCryosectionMenuRef} className="cryo-selector-control">
                  <button
                    type="button"
                    className={`cryo-selector-trigger ${
                      coordinatesCryosectionMenuOpen ? 'open' : ''
                    }`}
                    onClick={() =>
                      setCoordinatesCryosectionMenuOpen((prev) => !prev)
                    }
                    aria-expanded={coordinatesCryosectionMenuOpen}
                  >
                    <span>
                      {getCryosectionName(activeCryosection) ||
                        `Cryosection ${activeCryosection + 1}`}
                    </span>
                    <span className="cryo-selector-caret" aria-hidden>
                      ▾
                    </span>
                  </button>
                  {coordinatesCryosectionMenuOpen ? (
                    <div className="cryo-selector-menu">
                      {selectableCryosectionIndexes.map((cryoIndex) => (
                        <button
                          key={`viewer-cryo-option-${cryoIndex}`}
                          type="button"
                          className={`cryo-selector-option ${
                            activeCryosection === cryoIndex ? 'active' : ''
                          }`}
                          onClick={() => {
                            setActiveCryosection(cryoIndex);
                            setCoordinatesCryosectionMenuOpen(false);
                          }}
                        >
                          {getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              <aside className="sidebar">
                <div className="sidebar-header sidebar-header-stack">
                  <div className="button-row">
                    <button className="primary" onClick={handleOpen}>
                      Import LIF files
                    </button>
                    <button className="secondary" onClick={handleOpenCsv}>
                      Import CSV file
                    </button>
                  </div>
                  <div className="sidebar-action-row">
                    <button
                      className="secondary"
                      onClick={handleReuseCoordinateSources}
                      disabled={coordinatesReuseOptions.length === 0 || coordinatesReuseSource === null}
                    >
                      Reuse from
                    </button>
                    <div ref={coordinatesReuseMenuRef} className="cryo-selector-control sidebar-action-dropdown">
                      <button
                        type="button"
                        className={`cryo-selector-trigger ${coordinatesReuseMenuOpen ? 'open' : ''}`}
                        onClick={() => {
                          if (coordinatesReuseOptions.length === 0) {
                            return;
                          }
                          setCoordinatesReuseMenuOpen((prev) => !prev);
                        }}
                        aria-expanded={coordinatesReuseMenuOpen}
                        disabled={coordinatesReuseOptions.length === 0}
                      >
                        <span>
                          {coordinatesReuseSource !== null
                            ? getCryosectionName(coordinatesReuseSource) ||
                              `Cryosection ${coordinatesReuseSource + 1}`
                            : 'No other cryosections'}
                        </span>
                        <span className="cryo-selector-caret" aria-hidden>
                          ▾
                        </span>
                      </button>
                      {coordinatesReuseMenuOpen ? (
                        <div className="cryo-selector-menu">
                          {coordinatesReuseOptions.map((cryoIndex) => (
                            <button
                              key={`coordinates-reuse-option-${cryoIndex}`}
                              type="button"
                              className={`cryo-selector-option ${
                                coordinatesReuseSource === cryoIndex ? 'active' : ''
                              }`}
                              onClick={() => {
                                setCoordinatesReuseSource(cryoIndex);
                                setCoordinatesReuseMenuOpen(false);
                              }}
                            >
                              {getCryosectionName(cryoIndex) || `Cryosection ${cryoIndex + 1}`}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      className="secondary danger"
                      onClick={() => setDetachCryoPromptOpen(true)}
                      disabled={
                        lifFiles.length === 0 &&
                        csvFiles.length === 0 &&
                        (elementsByCryo[activeCryosection]?.length ?? 0) === 0 &&
                        (csvPlacementsByCryo[activeCryosection]?.length ?? 0) === 0
                      }
                    >
                      Detach sources
                    </button>
                  </div>
                </div>

                <button className="secondary" onClick={handleCalculateCoordinates}>
                  Calculate coordinates
                </button>
                <div className="button-row">
                  <button
                    className="secondary"
                    onClick={handleFrameCoordinateCutPoints}
                    disabled={visibleCoordinateCutPoints.length === 0}
                  >
                    Frame cut points
                  </button>
                  <button
                    className="secondary"
                    onClick={handleFrameCoordinateImages}
                    disabled={coordinateVisibleImagePoints.length === 0}
                  >
                    Frame images
                  </button>
                </div>
                {coordDebug ? (
                  <div className="coord-debug">
                    {coordDebug.split('\n').map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                ) : null}
                <div className="sidebar-meta">
                  <div className="label">LIF files</div>
                  <div className="value">{lifFiles.length} loaded</div>
                  <div className="file-list">
                    {lifFiles.length === 0
                      ? '—'
                      : lifFiles.map((file) => (
                          <div key={file} className="file-item">
                            {file.split(/[\\\\/]/).pop()}
                          </div>
                        ))}
                  </div>
                </div>

                <div className="sidebar-meta">
                  <div className="label">CSV files</div>
                  <div className="value">{csvFiles.length} loaded</div>
                  <div className="file-list">
                    {csvFiles.length === 0
                      ? '—'
                      : csvFiles.map((file) => (
                          <div key={file} className="file-item">
                            {file.split(/[\\\\/]/).pop()}
                          </div>
                        ))}
                  </div>
                </div>

              {csvValidationMessage ? (
                <div className="sidebar-status">{csvValidationMessage}</div>
              ) : null}
              {thumbProgress ? (
                <div className="thumb-progress">
                  <div className="thumb-progress-track">
                    <div
                      className="thumb-progress-bar"
                      style={{
                        width: `${Math.max(
                          6,
                          Math.round((thumbProgress.done / thumbProgress.total) * 100)
                        )}%`
                      }}
                    />
                  </div>
                  <div className="thumb-progress-label">
                    Generating thumbnails {thumbProgress.done}/{thumbProgress.total}
                  </div>
                </div>
              ) : null}

                <div className="control-box">
                  <div className="control-title">Stitching Controls</div>
                  <label className="control-row">
                    <span>Image opacity</span>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={Math.round(imageOpacity * 100)}
                      onChange={(event) => setImageOpacity(Number(event.target.value) / 100)}
                    />
                    <span className="control-value">{Math.round(imageOpacity * 100)}%</span>
                  </label>
                  <label className="control-row">
                    <span>µm per pixel</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.001"
                      value={micronsPerPixel}
                      onChange={(event) => setMicronsPerPixel(Number(event.target.value) || 0)}
                    />
                  </label>
                  <div className="control-hint">
                    Adjust µm per pixel to align stage coordinates with image sizes.
                  </div>
                </div>
              </aside>
            </div>

            <main className="main">
              {errorBanner ? (
                <div className="main-alert error">{errorBanner}</div>
              ) : controlCoordinateIssues > 0 || positiveMissingCoordinates > 0 ? (
                <div className="main-alert error">
                  {controlCoordinateIssues > 0
                    ? `${controlCoordinateIssues} R/Z control wells contain coordinates. `
                    : ''}
                  {positiveMissingCoordinates > 0
                    ? `${positiveMissingCoordinates} positive samples are missing coordinates.`
                    : ''}
                </div>
              ) : null}
              <section className="map" ref={mapContainerRef} onWheel={handleMapWheel}>
                <canvas
                  ref={mapCanvasRef}
                  onPointerDown={handleMapPointerDown}
                  onPointerMove={handleMapPointerMove}
                  onPointerUp={handleMapPointerUp}
                  onPointerLeave={handleMapPointerLeave}
                  onWheel={handleMapWheel}
                  onContextMenu={(event) => event.preventDefault()}
                />
              </section>
            </main>
            <aside className="viewer-sidebar right">
              <div className="sidebar right-sidebar coordinates-right-sidebar">
                <div className="sidebar-header">
                  <div>
                    <div className="app-title">Coordinates</div>
                  </div>
                </div>
                <div className={`filter-box ${coordinatesFiltersCollapsed ? 'collapsed' : ''}`}>
                  <button
                    type="button"
                    className="collapsible-title-btn"
                    onClick={() => setCoordinatesFiltersCollapsed((prev) => !prev)}
                    aria-expanded={!coordinatesFiltersCollapsed}
                  >
                    <span className="control-title">FILTERS</span>
                    <span
                      className={`collapsible-caret ${coordinatesFiltersCollapsed ? '' : 'expanded'}`}
                      aria-hidden
                    >
                      ▾
                    </span>
                  </button>
                  {coordinatesFiltersCollapsed ? null : (
                    <>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={filterPre}
                          onChange={(event) => setFilterPre(event.target.checked)}
                        />
                        <span>Pre-cut (pre_wil)</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={filterPost}
                          onChange={(event) => setFilterPost(event.target.checked)}
                        />
                        <span>Post-cut (cut_wol)</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={showCutPoints}
                          onChange={(event) => setShowCutPoints(event.target.checked)}
                        />
                        <span>Cut points</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={showCutLabels}
                          onChange={(event) => setShowCutLabels(event.target.checked)}
                        />
                        <span>Microsample labels</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={showCoordinateOrphanPreImages}
                          onChange={(event) =>
                            setShowCoordinateOrphanPreImages(event.target.checked)
                          }
                        />
                        <span>Orphan pre-cut</span>
                      </label>
                      <label className="filter-row">
                        <input
                          type="checkbox"
                          checked={showCoordinateOrphanPostImages}
                          onChange={(event) =>
                            setShowCoordinateOrphanPostImages(event.target.checked)
                          }
                        />
                        <span>Orphan post-cut</span>
                      </label>
                    </>
                  )}
                </div>
                <div className={`control-box ${coordinatesSelectionCollapsed ? 'collapsed' : ''}`}>
                  <button
                    type="button"
                    className="collapsible-title-btn"
                    onClick={() => setCoordinatesSelectionCollapsed((prev) => !prev)}
                    aria-expanded={!coordinatesSelectionCollapsed}
                  >
                    <span className="control-title">SELECTION</span>
                    <span
                      className={`collapsible-caret ${coordinatesSelectionCollapsed ? '' : 'expanded'}`}
                      aria-hidden
                    >
                      ▾
                    </span>
                  </button>
                  {coordinatesSelectionCollapsed ? null : (
                    <>
                      <div className="search-row">
                        <input
                          type="text"
                          placeholder="Filter cut points..."
                          value={cutPointSearch}
                          onChange={(event) => setCutPointSearch(event.target.value)}
                        />
                      </div>
                      <div className="cutpoint-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => applyFilteredCutPointSelection(true)}
                        >
                          Select filtered
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => applyFilteredCutPointSelection(false)}
                        >
                          Deselect filtered
                        </button>
                      </div>
                      <div className="cutpoints-list">
                        {cutPointRows.length === 0 ? (
                          <div className="empty-list">No cut points loaded.</div>
                        ) : (
                          <table className="cutpoints-table">
                            <colgroup>
                              <col className="col-check" />
                              <col className="col-check" />
                              <col className="col-plate" />
                              <col className="col-well" />
                              <col className="col-code" />
                              <col className="col-image" />
                              <col className="col-image" />
                            </colgroup>
                            <thead>
                              <tr>
                                <th className="cutpoint-head check">POI</th>
                                <th className="cutpoint-head check">IMA</th>
                                <th className="cutpoint-head">Plate</th>
                                <th className="cutpoint-head">Well</th>
                                <th className="cutpoint-head">Microsample</th>
                                <th className="cutpoint-head">Pre image</th>
                                <th className="cutpoint-head">Post image</th>
                              </tr>
                            </thead>
                            <tbody>
                              {cutPointRows.map((row) => {
                                const visibility = cutPointVisibility[row.id] ?? {
                                  point: true,
                                  image: true
                                };
                                return (
                                  <tr key={row.id} className={`meta-${row.sample}`}>
                                    <td className="cutpoint-cell check">
                                      <input
                                        type="checkbox"
                                        checked={visibility.point}
                                        title="Point"
                                        onChange={(event) =>
                                          updateCutPointVisibility(
                                            row.id,
                                            'point',
                                            event.target.checked
                                          )
                                        }
                                      />
                                    </td>
                                    <td className="cutpoint-cell check">
                                      <input
                                        type="checkbox"
                                        checked={visibility.image}
                                        title="Image"
                                        onChange={(event) =>
                                          updateCutPointVisibility(
                                            row.id,
                                            'image',
                                            event.target.checked
                                          )
                                        }
                                      />
                                    </td>
                                    <td className="cutpoint-cell plate">{row.plateLabel}</td>
                                    <td className="cutpoint-cell well">{formatWellDisplay(row.well)}</td>
                                    <td className="cutpoint-cell code">{row.code || '—'}</td>
                                    <td className="cutpoint-cell image" title={row.preImage || ''}>
                                      {row.preImage || '—'}
                                    </td>
                                    <td className="cutpoint-cell image" title={row.cutImage || ''}>
                                      {row.cutImage || '—'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className={`control-box ${coordinatesOrphansCollapsed ? 'collapsed' : ''}`}>
                  <button
                    type="button"
                    className="collapsible-title-btn"
                    onClick={() => setCoordinatesOrphansCollapsed((prev) => !prev)}
                    aria-expanded={!coordinatesOrphansCollapsed}
                  >
                    <span className="control-title">ORPHAN IMAGES</span>
                    <span
                      className={`collapsible-caret ${coordinatesOrphansCollapsed ? '' : 'expanded'}`}
                      aria-hidden
                    >
                      ▾
                    </span>
                  </button>
                  {coordinatesOrphansCollapsed ? null : (
                    <>
                      <div className="cutpoint-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setAllOrphanImageVisibility(true)}
                        >
                          Show all
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setAllOrphanImageVisibility(false)}
                        >
                          Hide all
                        </button>
                      </div>
                      <div className="search-row orphan-collector-filter-row">
                        <select
                          className="search-scope-select orphan-collector-select"
                          value={coordinateOrphanCollectorFilter}
                          onChange={(event) =>
                            setCoordinateOrphanCollectorFilter(event.target.value)
                          }
                        >
                          <option value="all">All collectors</option>
                          {PLATE_ROWS.map((letter) => (
                            <option key={`orphan-collector-${letter}`} value={letter}>
                              Collector {letter}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="orphan-images-list">
                        {orphanImageRows.length === 0 ? (
                          <div className="empty-list">No orphan images.</div>
                        ) : (
                          <table className="cutpoints-table orphan-images-table">
                            <colgroup>
                              <col className="col-check" />
                              <col className="col-code" />
                              <col className="col-well" />
                            </colgroup>
                            <thead>
                              <tr>
                                <th className="cutpoint-head check">VIS</th>
                                <th className="cutpoint-head">Image</th>
                                <th className="cutpoint-head">Collector</th>
                              </tr>
                            </thead>
                            <tbody>
                              {orphanImageRows.map((row) => (
                                <tr key={row.id} className="orphan-image-row">
                                  <td className="cutpoint-cell check">
                                    <input
                                      type="checkbox"
                                      checked={row.visible}
                                      title="Visible"
                                      onChange={(event) =>
                                        updateOrphanImageVisibility(row.id, event.target.checked)
                                      }
                                    />
                                  </td>
                                  <td className="cutpoint-cell code" title={row.name}>
                                    {row.name}
                                  </td>
                                  <td className="cutpoint-cell well">
                                    {row.collector || '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>
      {userPromptOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-title">Start session</div>
            <div className="modal-text">
              Select one or more users for this session.
            </div>
            <div className="modal-user-list">
              {availableUsers.map((user, index) => (
                <label key={user} className="modal-user-option">
                  <input
                    type="checkbox"
                    checked={selectedSessionUsers.includes(user)}
                    onChange={(event) => handleToggleSessionUser(user, event.target.checked)}
                    autoFocus={index === 0}
                  />
                  <span>{user}</span>
                </label>
              ))}
            </div>
            <div className="modal-add-user">
              <input
                type="text"
                value={newUserInput}
                placeholder="Add user..."
                onChange={(event) => setNewUserInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleAddUser();
                  }
                }}
              />
              <button
                type="button"
                className="secondary"
                onClick={handleAddUser}
                disabled={!newUserInput.trim()}
              >
                Add
              </button>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                onClick={handleConfirmUser}
                disabled={selectedSessionUsers.length === 0}
              >
                Start session
              </button>
            </div>
          </div>
        </div>
      )}
      {legacyCollectionPrompt && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-title">Correct legacy collection values?</div>
            <div className="modal-text">
              This session file was saved with LMDmapper {legacyCollectionPrompt.version}, where
              collection `Y` values were offset by +1.
            </div>
            <div className="modal-text">
              Choose whether to correct the old mapping (`X` → `y0`, `1 tick` → `y1`, `2 ticks`
              → `y2`, `3 ticks` → `y3`) or keep the legacy interpretation for this file.
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => applyLegacyCollectionEncodingChoice('legacy')}
              >
                Proceed as is
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => applyLegacyCollectionEncodingChoice('corrected')}
              >
                Correct
              </button>
            </div>
          </div>
        </div>
      )}
      {statusPrompt && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-title">
              {statusPrompt.manualAssigned && isManualCoordinateLabel(statusPrompt.images)
                ? 'Manual coordinate actions'
                : 'Linked image actions'}
            </div>
            <div className="modal-text">
              Well {formatWellDisplay(statusPrompt.well)}
              {statusPrompt.code ? ` · ${statusPrompt.code}` : ''}
            </div>
            <div className="modal-text">
              {statusPrompt.manualAssigned && isManualCoordinateLabel(statusPrompt.images)
                ? 'These coordinates were entered manually in Coordinates.'
                : statusPrompt.manualAssigned
                  ? 'This microsample was linked manually from an orphan image selection.'
                : statusPrompt.inferred && !statusPrompt.inferenceConfirmed
                  ? 'This microsample was linked by inference rather than by a direct CSV image name.'
                : 'This microsample has linked LIF images and coordinates.'}
            </div>
            {statusPrompt.manualAssigned && isManualCoordinateLabel(statusPrompt.images) ? null : (
              <div className="modal-text modal-code-block">{statusPrompt.images}</div>
            )}
            <div className="modal-text">
              {statusPrompt.manualAssigned && isManualCoordinateLabel(statusPrompt.images)
                ? 'Removing the manual coordinate will clear the stored coordinates and size for this microsample.'
                : 'Removing the link will clear the stored image label and coordinates for this microsample. Any detached LIF images will become orphan images again.'}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={closeStatusPrompt}
              >
                Cancel
              </button>
              <button type="button" className="secondary danger" onClick={unlinkStatusPromptImages}>
                {statusPrompt.manualAssigned && isManualCoordinateLabel(statusPrompt.images)
                  ? 'Remove manual coordinate'
                  : 'Remove image link'}
              </button>
              {statusPrompt.manualAssigned || (statusPrompt.inferred && !statusPrompt.inferenceConfirmed) ? (
                <button
                  type="button"
                  className="primary"
                  onClick={confirmStatusPromptInference}
                >
                  Confirm coordinates
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {detachCryoPromptOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-title">Detach imported sources?</div>
            <div className="modal-text">
              This will remove the imported LIF files, CSV files, parsed image links, and cached
              coordinates for{' '}
              {getCryosectionName(activeCryosection) || `Cryosection ${activeCryosection + 1}`}.
            </div>
            <div className="modal-text">
              Use this when a cryosection needs a clean reimport or a fresh `Reuse from` rebuild.
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setDetachCryoPromptOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary danger"
                onClick={handleDetachCoordinateSources}
              >
                Detach sources
              </button>
            </div>
          </div>
        </div>
      )}
      {manualCoordinatePrompt && (
        <div className="modal-backdrop">
          <div className="modal-card manual-coordinate-modal">
            <div className="modal-title">Assign coordinates</div>
            <div className="modal-text">
              Enter the stage coordinates for the new cut point and link them to a metadata row
              that does not have coordinates yet.
            </div>
            <div className="manual-coordinate-grid">
              <label className="form-field">
                <span>X coordinate</span>
                <input
                  type="number"
                  step="0.01"
                  value={manualCoordinateDrafts.x}
                  onChange={(event) =>
                    setManualCoordinateDrafts((prev) => ({
                      ...prev,
                      x: event.target.value
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>Y coordinate</span>
                <input
                  type="number"
                  step="0.01"
                  value={manualCoordinateDrafts.y}
                  onChange={(event) =>
                    setManualCoordinateDrafts((prev) => ({
                      ...prev,
                      y: event.target.value
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>Size</span>
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={manualCoordinateDrafts.size}
                  onChange={(event) =>
                    setManualCoordinateDrafts((prev) => ({
                      ...prev,
                      size: event.target.value
                    }))
                  }
                />
              </label>
            </div>
            <label className="form-field">
              <span>Metadata row</span>
              <select
                value={selectedManualCoordinateTargetKey ?? ''}
                onChange={(event) => setSelectedManualCoordinateTargetKey(event.target.value || null)}
              >
                {manualCoordinatePrompt.targets.length === 0 ? (
                  <option value="">No rows without coordinates</option>
                ) : (
                  manualCoordinatePrompt.targets.map((target) => {
                    const key = orphanAssignmentTargetKey(target);
                    return (
                      <option key={key} value={key}>
                        {`${target.plateLabel} · ${target.well}${target.code ? ` · ${target.code}` : ''}`}
                      </option>
                    );
                  })
                )}
              </select>
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={closeManualCoordinatePrompt}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!selectedManualCoordinateTarget}
                onClick={assignManualCoordinatesToTarget}
              >
                Assign coordinates
              </button>
            </div>
          </div>
        </div>
      )}
      {orphanAssignmentPrompt && (
        <div className="modal-backdrop">
          <div className="modal-card orphan-assignment-modal">
            <div className="orphan-assignment-header">
              <div className="modal-title">Assign orphan image</div>
              {selectedOrphanAssignmentTarget && orphanAssignmentHiddenImageCount > 0 ? (
                <button
                  type="button"
                  className="secondary orphan-assignment-toggle"
                  onClick={() => setShowAllOrphanAssignmentImages((prev) => !prev)}
                >
                  {showAllOrphanAssignmentImages ? 'Show expected range' : 'Show all images'}
                </button>
              ) : null}
            </div>
            <div className="modal-text">{orphanAssignmentPrompt.contextLabel}</div>
            <div className="modal-text">
              {orphanAssignmentPrompt.collector
                ? `Select the missing plate position on collector row ${orphanAssignmentPrompt.collector} that should receive this cut point.`
                : 'Select the missing plate position that should receive this cut point.'}
            </div>
            {selectedOrphanAssignmentTarget && orphanAssignmentSelectionHasMixedStages ? (
              <div className="modal-text">
                Selected images from different stage positions cannot be assigned together.
              </div>
            ) : null}
            <div className="orphan-assignment-layout">
              <div className="modal-user-list modal-choice-list orphan-target-list">
                {orphanAssignmentPrompt.targets.length === 0 ? (
                  <div className="empty-list">
                    {orphanAssignmentPrompt.collector
                      ? `No missing sampling points are available on collector row ${orphanAssignmentPrompt.collector}.`
                      : 'No missing sampling points are available.'}
                  </div>
                ) : (
                  orphanAssignmentPrompt.targets.map((target) => {
                    const targetKey = orphanAssignmentTargetKey(target);
                    return (
                      <button
                        key={targetKey}
                        type="button"
                        className={`modal-choice-button meta-${target.sample}${
                          targetKey === selectedOrphanAssignmentTargetKey ? ' active' : ''
                        }`}
                        onClick={() => setSelectedOrphanAssignmentTargetKey(targetKey)}
                      >
                        <span>{target.plateLabel}</span>
                        <span>{target.well}</span>
                        <span>{target.code || '—'}</span>
                      </button>
                    );
                  })
                )}
              </div>
              {selectedOrphanAssignmentTarget ? (
                <div className="orphan-preview-grid-wrap">
                  <div className="orphan-preview-grid">
                    {visibleOrphanAssignmentImageOptions.length === 0 ? (
                      <div className="empty-list">
                        {orphanAssignmentExpectedImageRange && !showAllOrphanAssignmentImages
                          ? 'No orphan images fall within the expected image-number range for this position. Use "Show all images" to inspect the full collector set.'
                          : 'No orphan images are available for this collector.'}
                      </div>
                    ) : (
                      visibleOrphanAssignmentImageOptions.map((option) => {
                        const previewState = orphanAssignmentPreviewState[option.key] ?? {
                          loading: false
                        };
                        return (
                          <OrphanAssignmentPreviewCard
                            key={option.key}
                            title={option.group === 'pre' ? 'Pre-cut' : 'Post-cut'}
                            imageName={option.imageName}
                            thumb={previewState.thumb}
                            loading={previewState.loading}
                            error={previewState.error}
                            cutPixelX={orphanAssignmentPreviewPixel.x}
                            cutPixelY={orphanAssignmentPreviewPixel.y}
                            originalImageWidth={option.width}
                            originalImageHeight={option.height}
                            stageX={option.stageX}
                            stageY={option.stageY}
                            checked={selectedOrphanAssignmentImageKeys.includes(option.key)}
                            disabled={!selectedOrphanAssignmentTarget}
                            onToggle={() => toggleOrphanAssignmentImage(option.key)}
                          />
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={closeOrphanAssignmentPrompt}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!selectedOrphanAssignmentTarget || selectedOrphanAssignmentImageKeys.length === 0}
                onClick={assignOrphanImageToTarget}
              >
                Assign selected images
              </button>
            </div>
          </div>
        </div>
      )}
      {metadataExportPopupOpen && (
        <div className="modal-backdrop">
          <div className="modal-card metadata-export-modal">
            <div className="modal-title">Export metadata CSV</div>
            <div className="modal-text">
              Select the columns to export and drag them to set the export order.
            </div>
            <div className="metadata-export-list">
              {orderedMetadataExportColumns.map((column) => (
                <div
                  key={`metadata-export-${column.key}`}
                  className={`metadata-column-item ${
                    draggedMetadataExportKey === column.key ? 'dragging' : ''
                  }`}
                  draggable
                  onDragStart={() => setDraggedMetadataExportKey(column.key)}
                  onDragEnd={() => setDraggedMetadataExportKey(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedMetadataExportKey) {
                      reorderMetadataExportColumns(draggedMetadataExportKey, column.key);
                    }
                    setDraggedMetadataExportKey(null);
                  }}
                >
                  <span className="metadata-column-handle" aria-hidden>
                    ⋮⋮
                  </span>
                  <label className="filter-row">
                    <input
                      type="checkbox"
                      checked={metadataExportColumns[column.key] !== false}
                      onChange={(event) =>
                        setMetadataExportColumns((prev) => ({
                          ...prev,
                          [column.key]: event.target.checked
                        }))
                      }
                    />
                    <span>{column.label}</span>
                  </label>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setMetadataExportPopupOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void handleExportMetadataCsv()}>
                Export CSV
              </button>
            </div>
          </div>
        </div>
      )}
      {closePromptOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-title">Close session?</div>
            <div className="modal-text">
              End the active session for {currentUserLabel} and close LMDmapper?
            </div>
            <div className="modal-text">
              Closing does not save the session file automatically.
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={handleCancelClosePrompt}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={handleConfirmClosePrompt}>
                Close session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
  const sampleCounts = (plate: PlateConfig) => {
    const counts: Record<SampleType, number> = { P: 0, M: 0, Z: 0, R: 0, N: 0 };
    for (const row of plate.cells) {
      for (const cell of row) {
        counts[cell] += 1;
      }
    }
    return counts;
  };
