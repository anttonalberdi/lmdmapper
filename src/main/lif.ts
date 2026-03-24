import * as fs from 'fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { LifElement, LifImageError, LifImageResponse, LifParseResult } from '../shared/lifTypes';

type LifCacheEntry = {
  filePath: string;
  headerEndOffset: number;
  fileSize: number;
  elements: LifElement[];
  memBlockOffsets: Map<string, number>;
  memBlockIndexReady: boolean;
};

const lifCache = new Map<string, LifCacheEntry>();

const MAX_HEADER_BYTES = 128 * 1024 * 1024;
const READ_CHUNK_SIZE = 1024 * 1024;
const OPENING_TAG = '<LMSDataContainerHeader';
const CLOSING_TAG = '</LMSDataContainerHeader>';

export async function parseLifFile(filePath: string): Promise<LifParseResult> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const { xmlText, headerEndOffset } = await readXmlHeader(handle);
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      allowBooleanAttributes: true
    });
    const xml = parser.parse(xmlText);
    const elements = extractElements(xml).map((element) => ({
      ...element,
      sourceFile: filePath
    }));

    lifCache.set(filePath, {
      filePath,
      headerEndOffset,
      fileSize: stat.size,
      elements,
      memBlockOffsets: new Map(),
      memBlockIndexReady: false
    });

    return { filePath, elements };
  } finally {
    await handle.close();
  }
}

async function resolveElement(
  filePath: string,
  elementId: string
): Promise<{ cache: LifCacheEntry; element: LifElement } | LifImageError> {
  let cache = lifCache.get(filePath);
  if (!cache) {
    await parseLifFile(filePath);
    cache = lifCache.get(filePath);
  }
  if (!cache) {
    return { elementId, error: 'Failed to parse file.' };
  }

  const element = cache.elements.find((item) => item.id === elementId);
  if (!element) {
    return { elementId, error: 'Element not found.' };
  }
  if (!element.supported) {
    return { elementId, error: 'Unsupported image format.' };
  }
  if (
    !element.memoryBlockId ||
    !element.memorySize ||
    !element.width ||
    !element.height ||
    !element.channels
  ) {
    return { elementId, error: 'Missing memory block metadata.' };
  }

  return { cache, element };
}

async function resolveMemBlockOffset(
  handle: fs.FileHandle,
  cache: LifCacheEntry,
  element: LifElement
): Promise<number> {
  let offset = cache.memBlockOffsets.get(element.memoryBlockId as string);
  if (offset === undefined) {
    if (!cache.memBlockIndexReady && cache.elements.length > 1) {
      await buildMemBlockIndex(handle, cache);
    }
    offset = cache.memBlockOffsets.get(element.memoryBlockId as string);
    if (offset === undefined) {
      offset = await findMemBlockOffset(
        handle,
        cache.fileSize,
        cache.headerEndOffset,
        element.memoryBlockId as string,
        element.memorySize as number
      );
    }
    cache.memBlockOffsets.set(element.memoryBlockId as string, offset);
  }
  return offset;
}

export async function loadLifImage(filePath: string, elementId: string): Promise<LifImageResponse> {
  const resolved = await resolveElement(filePath, elementId);
  if ('error' in resolved) {
    return resolved;
  }
  const { cache, element } = resolved;

  const handle = await fs.open(filePath, 'r');
  try {
    const offset = await resolveMemBlockOffset(handle, cache, element);

    const buffer = Buffer.allocUnsafe(element.memorySize as number);
    const { bytesRead } = await handle.read(buffer, 0, element.memorySize as number, offset);
    if (bytesRead !== element.memorySize) {
      return { elementId, error: 'Unexpected end of file while reading image data.' };
    }

    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );

    return {
      elementId,
      width: element.width as number,
      height: element.height as number,
      channels: element.channels as number,
      format: 'rgb',
      data: arrayBuffer
    };
  } finally {
    await handle.close();
  }
}

export async function loadLifThumbnail(
  filePath: string,
  elementId: string,
  maxSize: number
): Promise<LifImageResponse> {
  const resolved = await resolveElement(filePath, elementId);
  if ('error' in resolved) {
    return resolved;
  }
  const { cache, element } = resolved;

  const width = element.width as number;
  const height = element.height as number;
  const channels = element.channels as number;
  const safeMax = Math.max(1, Math.min(4096, Math.floor(maxSize || 1)));
  const scale = Math.min(1, safeMax / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));

  const handle = await fs.open(filePath, 'r');
  try {
    const offset = await resolveMemBlockOffset(handle, cache, element);
    const rowSize = width * channels;
    const rowBuffer = Buffer.allocUnsafe(rowSize);
    const outBuffer = Buffer.allocUnsafe(outWidth * outHeight * channels);

    for (let y = 0; y < outHeight; y += 1) {
      const srcY = Math.min(height - 1, Math.floor((y / outHeight) * height));
      const rowOffset = offset + srcY * rowSize;
      const { bytesRead } = await handle.read(rowBuffer, 0, rowSize, rowOffset);
      if (bytesRead !== rowSize) {
        return { elementId, error: 'Unexpected end of file while reading image data.' };
      }
      for (let x = 0; x < outWidth; x += 1) {
        const srcX = Math.min(width - 1, Math.floor((x / outWidth) * width));
        const srcIndex = srcX * channels;
        const dstIndex = (y * outWidth + x) * channels;
        outBuffer[dstIndex] = rowBuffer[srcIndex];
        outBuffer[dstIndex + 1] = rowBuffer[srcIndex + 1];
        outBuffer[dstIndex + 2] = rowBuffer[srcIndex + 2];
      }
    }

    const arrayBuffer = outBuffer.buffer.slice(
      outBuffer.byteOffset,
      outBuffer.byteOffset + outBuffer.byteLength
    );

    return {
      elementId,
      width: outWidth,
      height: outHeight,
      channels,
      format: 'rgb',
      data: arrayBuffer
    };
  } finally {
    await handle.close();
  }
}

async function readXmlHeader(handle: fs.FileHandle): Promise<{ xmlText: string; headerEndOffset: number }> {
  const closingBufUtf8 = Buffer.from(CLOSING_TAG, 'utf8');
  const closingBufUtf16 = Buffer.from(CLOSING_TAG, 'utf16le');
  const openingBufUtf8 = Buffer.from(OPENING_TAG, 'utf8');
  const openingBufUtf16 = Buffer.from(OPENING_TAG, 'utf16le');
  const maxClosingLength = Math.max(closingBufUtf8.length, closingBufUtf16.length);
  let totalRead = 0;
  const chunks: Buffer[] = [];
  let tail = Buffer.alloc(0);

  while (totalRead < MAX_HEADER_BYTES) {
    const toRead = Math.min(READ_CHUNK_SIZE, MAX_HEADER_BYTES - totalRead);
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, totalRead);
    if (bytesRead === 0) {
      break;
    }

    const slice = buffer.slice(0, bytesRead);
    chunks.push(slice);

    const combined = tail.length ? Buffer.concat([tail, slice]) : slice;
    const indexUtf8 = combined.indexOf(closingBufUtf8);
    const indexUtf16 = combined.indexOf(closingBufUtf16);
    let index = -1;
    let encoding: 'utf8' | 'utf16le' = 'utf8';
    let closingLength = closingBufUtf8.length;

    if (indexUtf8 !== -1 && (indexUtf16 === -1 || indexUtf8 <= indexUtf16)) {
      index = indexUtf8;
      encoding = 'utf8';
      closingLength = closingBufUtf8.length;
    } else if (indexUtf16 !== -1) {
      index = indexUtf16;
      encoding = 'utf16le';
      closingLength = closingBufUtf16.length;
    }

    if (index !== -1) {
      const endPosition = totalRead - tail.length + index + closingLength;
      const headerBuf = Buffer.concat(chunks, endPosition);
      const openingBuf = encoding === 'utf8' ? openingBufUtf8 : openingBufUtf16;
      const openingIndex = headerBuf.indexOf(openingBuf);
      const xmlSlice = openingIndex !== -1 ? headerBuf.slice(openingIndex) : headerBuf;
      return { xmlText: xmlSlice.toString(encoding), headerEndOffset: endPosition };
    }

    totalRead += bytesRead;
    const tailLength = Math.min(maxClosingLength - 1, combined.length);
    tail = combined.slice(combined.length - tailLength);
  }

  const limitMB = Math.round(MAX_HEADER_BYTES / (1024 * 1024));
  throw new Error(`XML header not found within ${limitMB} MB.`);
}

function extractElements(xml: unknown): LifElement[] {
  const elements: LifElement[] = [];
  let counter = 1;

  const elementNodes = findAllNodes(xml, 'Element');
  for (const elementNode of elementNodes) {
    const memoryNodes = findAllNodesExcluding(elementNode, 'Memory', ['Element']);
    if (memoryNodes.length === 0) {
      continue;
    }
    const memory = memoryNodes[0];
    const memoryBlockId = getAttr(memory, 'MemoryBlockID') || getAttr(memory, 'MemoryBlockId');
    const memorySize = toNumber(getAttr(memory, 'Size'));

    const name =
      getAttr(elementNode, 'Name') ||
      getAttr(elementNode, 'Caption') ||
      `Element ${counter}`;

    const imageDescriptions = findAllNodesExcluding(elementNode, 'ImageDescription', ['Element']);
    const imageDescNode = imageDescriptions[0] ?? elementNode;

    const dims = extractDimensions(imageDescNode);
    const channels = dims.channels ?? extractChannelCount(imageDescNode);
    const resolution = dims.resolution ?? extractResolution(imageDescNode);

    const stageXRaw = findFirstNumber(elementNode, [
      'StageposX',
      'StagePosX',
      'StagePositionX',
      'StageX'
    ]);
    const stageYRaw = findFirstNumber(elementNode, [
      'StageposY',
      'StagePosY',
      'StagePositionY',
      'StageY'
    ]);
    const collectorHolderPositionRaw = findFirstString(elementNode, [
      'Collectorholderposition',
      'CollectorholderPosition',
      'CollectorHolderPosition'
    ]);
    const stageX = typeof stageXRaw === 'number' && Number.isFinite(stageXRaw) ? stageXRaw / 10 : undefined;
    const stageY = typeof stageYRaw === 'number' && Number.isFinite(stageYRaw) ? stageYRaw / 10 : undefined;
    const collectorHolderPosition =
      typeof collectorHolderPositionRaw === 'string' && collectorHolderPositionRaw.trim().length > 0
        ? collectorHolderPositionRaw.trim().toUpperCase()
        : undefined;
    const timestamp = findFirstString(elementNode, ['DateAndTime', 'AcqDateTime', 'AcquisitionDateTime']);
    const laserSettings = extractLaserSettings(elementNode);

    const width = dims.width;
    const height = dims.height;

    const supported =
      Boolean(width && height && channels === 3 && resolution === 8 && memorySize) &&
      memorySize === width! * height! * 3;

    elements.push({
      id: memoryBlockId || `element_${counter}`,
      name,
      memoryBlockId: memoryBlockId || undefined,
      memorySize: memorySize || undefined,
      width,
      height,
      channels: channels || undefined,
      resolution: resolution || undefined,
      stageX,
      stageY,
      collectorHolderPosition,
      timestamp,
      laserSettings: laserSettings.length ? laserSettings : undefined,
      supported
    });

    counter += 1;
  }

  return elements;
}

async function findMemBlockOffset(
  handle: fs.FileHandle,
  fileSize: number,
  startOffset: number,
  memBlockId: string,
  expectedSize: number
): Promise<number> {
  // Scan the binary section for the memblock token (ASCII or UTF-16LE). When found,
  // infer the data start by reading a size prefix (uint64/uint32) or skipping padding.
  const asciiToken = Buffer.from(memBlockId, 'ascii');
  const utf16Token = Buffer.from(memBlockId, 'utf16le');
  const maxTokenLength = Math.max(asciiToken.length, utf16Token.length);
  let position = startOffset;
  let overlap = Buffer.alloc(0);

  while (position < fileSize) {
    const toRead = Math.min(READ_CHUNK_SIZE, fileSize - position);
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, position);
    if (bytesRead === 0) {
      break;
    }

    const combined = Buffer.concat([overlap, buffer.slice(0, bytesRead)]);
    const found = await scanForToken(
      handle,
      combined,
      position,
      overlap.length,
      fileSize,
      [
        { bytes: asciiToken, length: asciiToken.length },
        { bytes: utf16Token, length: utf16Token.length }
      ],
      expectedSize
    );
    if (found !== undefined) {
      return found;
    }

    position += bytesRead;
    const overlapLength = Math.min(maxTokenLength - 1, combined.length);
    overlap = combined.slice(combined.length - overlapLength);
  }

  const numericId = parseMemBlockNumber(memBlockId);
  if (numericId !== undefined) {
    const fallback = await findMemBlockOffsetByNumber(
      handle,
      fileSize,
      startOffset,
      numericId,
      expectedSize
    );
    if (fallback !== undefined) {
      return fallback;
    }
  }

  throw new Error(`MemBlock token not found for ${memBlockId}`);
}

async function buildMemBlockIndex(
  handle: fs.FileHandle,
  cache: LifCacheEntry
): Promise<void> {
  if (cache.memBlockIndexReady) {
    return;
  }

  const pending = new Map<string, number>();
  const pendingByNumber = new Map<number, { id: string; size: number }>();
  for (const element of cache.elements) {
    if (element.memoryBlockId && element.memorySize) {
      if (!cache.memBlockOffsets.has(element.memoryBlockId)) {
        pending.set(element.memoryBlockId, element.memorySize);
      }
      const numericId = parseMemBlockNumber(element.memoryBlockId);
      if (numericId !== undefined && !pendingByNumber.has(numericId)) {
        pendingByNumber.set(numericId, { id: element.memoryBlockId, size: element.memorySize });
      }
    }
  }

  if (pending.size === 0) {
    cache.memBlockIndexReady = true;
    return;
  }

  const asciiPrefix = Buffer.from('MemBlock_', 'ascii');
  const utf16Prefix = Buffer.from('MemBlock_', 'utf16le');
  const maxPrefixLength = Math.max(asciiPrefix.length, utf16Prefix.length);
  let position = cache.headerEndOffset;
  let overlap = Buffer.alloc(0);

  while (position < cache.fileSize && pending.size > 0) {
    const toRead = Math.min(READ_CHUNK_SIZE, cache.fileSize - position);
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, position);
    if (bytesRead === 0) {
      break;
    }

    const combined = Buffer.concat([overlap, buffer.slice(0, bytesRead)]);

    let index = combined.indexOf(asciiPrefix);
    while (index !== -1) {
      const idStart = index + asciiPrefix.length;
      let idEnd = idStart;
      while (idEnd < combined.length && combined[idEnd] >= 48 && combined[idEnd] <= 57) {
        idEnd += 1;
      }

      if (idEnd === combined.length) {
        break;
      }

      if (idEnd > idStart) {
        const digits = combined.slice(idStart, idEnd).toString('ascii');
        const resolved = resolvePendingMemBlock(digits, pending, pendingByNumber);
        if (resolved) {
          const globalIndex = position - overlap.length + index;
          const tokenLength = `MemBlock_${digits}`.length;
          const dataOffset = await computeDataOffset(
            handle,
            globalIndex,
            tokenLength,
            resolved.size
          );
          if (dataOffset + resolved.size <= cache.fileSize) {
            cache.memBlockOffsets.set(resolved.id, dataOffset);
            pending.delete(resolved.id);
            if (resolved.numericId !== undefined) {
              pendingByNumber.delete(resolved.numericId);
            }
          }
        }
      }

      index = combined.indexOf(asciiPrefix, index + 1);
    }

    let indexUtf16 = combined.indexOf(utf16Prefix);
    while (indexUtf16 !== -1) {
      const idStart = indexUtf16 + utf16Prefix.length;
      let idEnd = idStart;
      while (
        idEnd + 1 < combined.length &&
        combined.readUInt16LE(idEnd) >= 48 &&
        combined.readUInt16LE(idEnd) <= 57
      ) {
        idEnd += 2;
      }

      if (idEnd + 1 >= combined.length) {
        break;
      }

      if (idEnd > idStart) {
        const digits = combined.slice(idStart, idEnd).toString('utf16le');
        const resolved = resolvePendingMemBlock(digits, pending, pendingByNumber);
        if (resolved) {
          const globalIndex = position - overlap.length + indexUtf16;
          const tokenLength = Buffer.from(`MemBlock_${digits}`, 'utf16le').length;
          const dataOffset = await computeDataOffset(
            handle,
            globalIndex,
            tokenLength,
            resolved.size
          );
          if (dataOffset + resolved.size <= cache.fileSize) {
            cache.memBlockOffsets.set(resolved.id, dataOffset);
            pending.delete(resolved.id);
            if (resolved.numericId !== undefined) {
              pendingByNumber.delete(resolved.numericId);
            }
          }
        }
      }

      indexUtf16 = combined.indexOf(utf16Prefix, indexUtf16 + 2);
    }

    position += bytesRead;
    const overlapLength = Math.min(maxPrefixLength + 64, combined.length);
    overlap = combined.slice(combined.length - overlapLength);
  }

  cache.memBlockIndexReady = true;
}

async function scanForToken(
  handle: fs.FileHandle,
  combined: Buffer,
  position: number,
  overlapLength: number,
  fileSize: number,
  tokens: Array<{ bytes: Buffer; length: number }>,
  expectedSize: number
): Promise<number | undefined> {
  for (const token of tokens) {
    let index = combined.indexOf(token.bytes);
    while (index !== -1) {
      const globalIndex = position - overlapLength + index;
      const dataOffset = await computeDataOffset(
        handle,
        globalIndex,
        token.length,
        expectedSize
      );
      if (dataOffset + expectedSize <= fileSize) {
        return dataOffset;
      }
      index = combined.indexOf(token.bytes, index + 1);
    }
  }
  return undefined;
}

function resolvePendingMemBlock(
  digits: string,
  pending: Map<string, number>,
  pendingByNumber: Map<number, { id: string; size: number }>
): { id: string; size: number; numericId?: number } | null {
  const exactId = `MemBlock_${digits}`;
  const exactSize = pending.get(exactId);
  if (exactSize !== undefined) {
    const numericId = parseMemBlockNumber(exactId);
    return { id: exactId, size: exactSize, numericId };
  }

  const numeric = Number(digits);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const numericEntry = pendingByNumber.get(numeric);
  if (!numericEntry) {
    return null;
  }
  return { id: numericEntry.id, size: numericEntry.size, numericId: numeric };
}

function parseMemBlockNumber(memBlockId?: string): number | undefined {
  if (!memBlockId) {
    return undefined;
  }
  const match = /MemBlock_0*(\d+)/i.exec(memBlockId);
  if (!match) {
    return undefined;
  }
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : undefined;
}

async function findMemBlockOffsetByNumber(
  handle: fs.FileHandle,
  fileSize: number,
  startOffset: number,
  numericId: number,
  expectedSize: number
): Promise<number | undefined> {
  const asciiPrefix = Buffer.from('MemBlock_', 'ascii');
  const utf16Prefix = Buffer.from('MemBlock_', 'utf16le');
  const maxPrefixLength = Math.max(asciiPrefix.length, utf16Prefix.length);
  let position = startOffset;
  let overlap = Buffer.alloc(0);

  while (position < fileSize) {
    const toRead = Math.min(READ_CHUNK_SIZE, fileSize - position);
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, position);
    if (bytesRead === 0) {
      break;
    }

    const combined = Buffer.concat([overlap, buffer.slice(0, bytesRead)]);

    let index = combined.indexOf(asciiPrefix);
    while (index !== -1) {
      const idStart = index + asciiPrefix.length;
      let idEnd = idStart;
      while (idEnd < combined.length && combined[idEnd] >= 48 && combined[idEnd] <= 57) {
        idEnd += 1;
      }
      if (idEnd === combined.length) {
        break;
      }
      if (idEnd > idStart) {
        const digits = combined.slice(idStart, idEnd).toString('ascii');
        if (Number(digits) === numericId) {
          const tokenLength = `MemBlock_${digits}`.length;
          const globalIndex = position - overlap.length + index;
          const dataOffset = await computeDataOffset(
            handle,
            globalIndex,
            tokenLength,
            expectedSize
          );
          if (dataOffset + expectedSize <= fileSize) {
            return dataOffset;
          }
        }
      }
      index = combined.indexOf(asciiPrefix, index + 1);
    }

    let indexUtf16 = combined.indexOf(utf16Prefix);
    while (indexUtf16 !== -1) {
      const idStart = indexUtf16 + utf16Prefix.length;
      let idEnd = idStart;
      while (
        idEnd + 1 < combined.length &&
        combined.readUInt16LE(idEnd) >= 48 &&
        combined.readUInt16LE(idEnd) <= 57
      ) {
        idEnd += 2;
      }
      if (idEnd + 1 >= combined.length) {
        break;
      }
      if (idEnd > idStart) {
        const digits = combined.slice(idStart, idEnd).toString('utf16le');
        if (Number(digits) === numericId) {
          const tokenLength = Buffer.from(`MemBlock_${digits}`, 'utf16le').length;
          const globalIndex = position - overlap.length + indexUtf16;
          const dataOffset = await computeDataOffset(
            handle,
            globalIndex,
            tokenLength,
            expectedSize
          );
          if (dataOffset + expectedSize <= fileSize) {
            return dataOffset;
          }
        }
      }
      indexUtf16 = combined.indexOf(utf16Prefix, indexUtf16 + 2);
    }

    position += bytesRead;
    const overlapLength = Math.min(maxPrefixLength + 64, combined.length);
    overlap = combined.slice(combined.length - overlapLength);
  }

  return undefined;
}

async function computeDataOffset(
  handle: fs.FileHandle,
  tokenOffset: number,
  tokenLength: number,
  expectedSize: number
): Promise<number> {
  const probe = Buffer.allocUnsafe(16);
  await handle.read(probe, 0, 16, tokenOffset + tokenLength);

  const size64 = Number(probe.readBigUInt64LE(0));
  if (size64 === expectedSize) {
    return tokenOffset + tokenLength + 8;
  }

  const size32 = probe.readUInt32LE(0);
  if (size32 === expectedSize) {
    return tokenOffset + tokenLength + 4;
  }

  let skip = 0;
  while (skip < probe.length && probe[skip] === 0) {
    skip += 1;
  }

  return tokenOffset + tokenLength + skip;
}

function extractDimensions(node: unknown): {
  width?: number;
  height?: number;
  channels?: number;
  resolution?: number;
} {
  const dims = findAllNodes(node, 'DimensionDescription');
  let width: number | undefined;
  let height: number | undefined;
  let channels: number | undefined;
  let resolution: number | undefined;

  for (const dim of dims) {
    const rawDimId =
      getAttr(dim, 'DimID') || getAttr(dim, 'DimensionID') || getAttr(dim, 'DimId');
    const dimId = normalizeDimId(rawDimId);
    const count = toNumber(getAttr(dim, 'NumberOfElements') || getAttr(dim, 'NumberElements'));
    const res = toNumber(getAttr(dim, 'Resolution'));

    if (dimId === 'X' && count) {
      width = count;
    }
    if (dimId === 'Y' && count) {
      height = count;
    }
    if (dimId === 'C' && count) {
      channels = count;
    }
    if (!resolution && res) {
      resolution = res;
    }
  }

  return { width, height, channels, resolution };
}

function extractChannelCount(node: unknown): number | undefined {
  const channels = findAllNodes(node, 'ChannelDescription');
  if (channels.length > 0) {
    return channels.length;
  }
  return undefined;
}

function extractResolution(node: unknown): number | undefined {
  const channels = findAllNodes(node, 'ChannelDescription');
  for (const channel of channels) {
    const res = toNumber(getAttr(channel, 'Resolution')) || toNumber(getAttr(channel, 'BitsPerPixel'));
    if (res) {
      return res;
    }
  }
  return undefined;
}

function extractLaserSettings(node: unknown): string[] {
  const lasers = findAllNodes(node, 'LaserLineSetting');
  const lines = lasers.map((laser) => {
    const wavelength = getAttr(laser, 'Wavelength') || getAttr(laser, 'WavelengthNm');
    const power = getAttr(laser, 'Power');
    const pieces = [] as string[];
    if (wavelength) {
      pieces.push(`${wavelength}nm`);
    }
    if (power) {
      pieces.push(`P${power}`);
    }
    return pieces.join(' ');
  });

  return lines.filter((line) => line.length > 0);
}

function findAllNodes(node: unknown, key: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const stack = [node];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(current, key)) {
      const value = (current as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') {
            results.push(item as Record<string, unknown>);
          }
        }
      } else if (value && typeof value === 'object') {
        results.push(value as Record<string, unknown>);
      }
    }

    for (const child of Object.values(current as Record<string, unknown>)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object') {
            stack.push(item);
          }
        }
      } else if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }

  return results;
}

function findAllNodesExcluding(
  node: unknown,
  key: string,
  excludeKeys: string[]
): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const stack = [node];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(current, key)) {
      const value = (current as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') {
            results.push(item as Record<string, unknown>);
          }
        }
      } else if (value && typeof value === 'object') {
        results.push(value as Record<string, unknown>);
      }
    }

    for (const [prop, child] of Object.entries(current as Record<string, unknown>)) {
      if (excludeKeys.includes(prop)) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object') {
            stack.push(item);
          }
        }
      } else if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }

  return results;
}

function findFirstNumber(node: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = findFirstValue(node, key);
    if (value !== undefined) {
      const num = toNumber(value);
      if (num !== undefined) {
        return num;
      }
    }
  }
  return undefined;
}

function findFirstString(node: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = findFirstValue(node, key);
    if (value !== undefined) {
      if (typeof value === 'string') {
        return value;
      }
      if (typeof value === 'number') {
        return value.toString();
      }
    }
  }
  return undefined;
}

function findFirstValue(node: unknown, key: string): unknown {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      return (current as Record<string, unknown>)[key];
    }
    const attrKey = `@_${key}`;
    if (Object.prototype.hasOwnProperty.call(current, attrKey)) {
      return (current as Record<string, unknown>)[attrKey];
    }
    for (const child of Object.values(current as Record<string, unknown>)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object') {
            stack.push(item);
          }
        }
      } else if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }
  return undefined;
}

function getAttr(node: Record<string, unknown>, attr: string): string | undefined {
  const key = `@_${attr}`;
  const value = node[key];
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(num)) {
    return num;
  }
  return undefined;
}

function normalizeDimId(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const upper = value.toUpperCase();
  if (upper === 'X' || upper === 'Y' || upper === 'Z' || upper === 'T' || upper === 'C') {
    return upper;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  switch (numeric) {
    case 1:
      return 'X';
    case 2:
      return 'Y';
    case 3:
      return 'Z';
    case 4:
      return 'T';
    case 5:
      return 'C';
    default:
      return undefined;
  }
}
