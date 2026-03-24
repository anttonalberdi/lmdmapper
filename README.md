# LMDmapper (v1.2.1)

Leica `.lif` spatial visualization tool built with Electron + Vite + React + TypeScript.

## Features
- Open one or more `.lif` files into a single project
- Parse and list image elements with metadata
- View 2D RGB 8-bit images
- Spatial layout canvas using stage positions

## Requirements
- Node.js 18+ (for Electron 29)
- npm

## Install
```bash
npm install
```

## Development
```bash
npm run dev
```

This launches Vite for the renderer, compiles the main process, and starts Electron.

## Build installers
```bash
npm run build
```

Electron Builder will generate macOS and Windows targets in `release/`.

## Release build workflow
1. Create the release notes file: `release-notes/<version>.md`
2. Run:
```bash
npm run release:build -- --version <x.y.z>
```

What this does:
- Updates project version files
- Updates `CHANGELOG.md` using `release-notes/<version>.md`
- Runs lint
- Builds macOS arm64 and Windows x64 installers
- Writes checksums to `release/SHA256SUMS-<version>.txt`

## Generate a toy `.lif`
```bash
npm run generate:fixture
```

This writes `toy.lif` in the project root. Use **Import LIF files** in the app to load it.

## Limitations (v1.2.1)
- Only supports 2D RGB, 8-bit, interleaved data (C=3)
- Elements with other formats are listed but show “Unsupported format (v1.2.1)”
- Spatial layout requires StageposX/StageposY metadata

## Notes
The parser expects an XML header (`LMSDataContainerHeader`) followed by raw mem block data.
It scans for `MemBlock_<id>` tokens (ASCII/UTF-16LE) and reads the expected number of bytes.
