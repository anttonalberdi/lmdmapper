# LMDmapper (v1.4.4)

LMDmapper is an open-source desktop tool for curating Leica laser
microdissection sessions. It links `.lif` image metadata, microscope CSV
exports, plate layouts, spatial coordinates, and downstream sample metadata in a
local Electron application built with Vite, React, and TypeScript.

Source code is hosted on GitHub so the application can be cloned, audited, and
modified. Packaged installers are generated locally in `release/`, which is
intentionally ignored by Git.

## Features
- Open one or more `.lif` files into a single project
- Parse and list image elements with metadata
- View 2D RGB 8-bit images
- Spatial layout canvas using stage positions

## Requirements
- Node.js 18+
- npm

## Clone and Install
```bash
git clone https://github.com/anttonalberdi/lmdmapper.git
cd lmdmapper
npm install
```

## Development
```bash
npm run dev
```

This launches Vite for the renderer, compiles the main process, and starts Electron.

## Build from Source
Validate the source build without creating installers:

```bash
npm run lint
npm run build:renderer
npm run build:main
```

## Build Installers
```bash
npm run build
```

Electron Builder will generate macOS and Windows targets in `release/`.

## Release Build Workflow
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
The generated file is ignored by Git.

## Limitations (v1.4.4)
- Only supports 2D RGB, 8-bit, interleaved data (C=3)
- Elements with other formats are listed but show “Unsupported format (v1.4.4)”
- Spatial layout requires StageposX/StageposY metadata

## Contributing and License

Contributions are welcome through GitHub issues and pull requests. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, validation, and large-file
guidance.

LMDmapper is released under the [MIT License](LICENSE). If you use it in
research, cite this repository; citation metadata is provided in
[CITATION.cff](CITATION.cff).

## Notes
The parser expects an XML header (`LMSDataContainerHeader`) followed by raw mem block data.
It scans for `MemBlock_<id>` tokens (ASCII/UTF-16LE) and reads the expected number of bytes.
