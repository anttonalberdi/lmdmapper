# LMDmapper (v1.4.5)

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20827562.svg)](https://doi.org/10.5281/zenodo.20827562)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

LMDmapper is an open-source desktop tool for curating Leica laser
microdissection sessions. It links `.lif` image metadata, microscope CSV
exports, plate layouts, spatial coordinates, and downstream sample metadata in a
local Electron application built with Vite, React, and TypeScript.

Source code is hosted on GitHub so the application can be cloned, audited, and
modified. Packaged installers and archives are generated locally in `release/`,
which is intentionally ignored by Git.

## Download

Pre-built installers for **v1.4.5** are archived on Zenodo
([DOI 10.5281/zenodo.20827563](https://doi.org/10.5281/zenodo.20827563)). Pick
the build for your platform; the right-hand column lists alternative formats.

| Platform | Architecture | Installer | Other formats |
| --- | --- | --- | --- |
| macOS | Apple Silicon (arm64) | [`.dmg`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_arm64_mac.dmg?download=1) | [`.zip`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_arm64_mac.zip?download=1) |
| macOS | Intel (x64) | [`.dmg`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_x64_mac.dmg?download=1) | [`.zip`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_x64_mac.zip?download=1) |
| Windows | x64 | [`.exe`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_x64_win.exe?download=1) | [`.zip`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_x64_win.zip?download=1) |
| Windows | arm64 | [`.exe`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_arm64_win.exe?download=1) | [`.zip`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_arm64_win.zip?download=1) |
| Windows | 32-bit (ia32) | [`.exe`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_ia32_win.exe?download=1) | [`.zip`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_ia32_win.zip?download=1) |
| Linux | x64 (x86_64) | [`.AppImage`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_x86_64_linux.AppImage?download=1) | [`.deb`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_amd64_linux.deb?download=1) · [`.rpm`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_x86_64_linux.rpm?download=1) · [`.tar.gz`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_x64_linux.tar.gz?download=1) |
| Linux | arm64 (aarch64) | [`.AppImage`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_arm64_linux.AppImage?download=1) | [`.deb`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_arm64_linux.deb?download=1) · [`.rpm`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_aarch64_linux.rpm?download=1) · [`.tar.gz`](https://zenodo.org/records/20827563/files/lmdmapper_1.4.5_arm64_linux.tar.gz?download=1) |

Verify downloads against [`SHA256SUMS-1.4.5.txt`](https://zenodo.org/records/20827563/files/SHA256SUMS-1.4.5.txt?download=1).
For other releases, browse the
[all-versions Zenodo record](https://doi.org/10.5281/zenodo.20827562) or the
[GitHub releases page](https://github.com/anttonalberdi/lmdmapper/releases).

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

Electron Builder will generate the default target for the current operating
system in `release/`. Use the platform-specific commands for release artifacts:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

Release builds cover:

| System | Architectures | Artifacts |
| --- | --- | --- |
| macOS | x64, arm64 | DMG, ZIP |
| Windows | x64, arm64, ia32 | NSIS installer, ZIP |
| Linux | x64, arm64 | AppImage, DEB, RPM, tar.gz |

macOS artifacts should be built on macOS. Linux artifacts should be built on a
Linux host or with Electron Builder's Linux build container; the release
workflow builds Linux x64 and arm64 on separate native runners.

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
- Builds the release artifacts supported by the current host
- Writes checksums for all built release artifacts to `release/SHA256SUMS-<version>.txt`

Tagged releases named `v<x.y.z>` also run the GitHub Actions release workflow,
which builds macOS, Windows, and Linux artifacts on separate runners and
publishes them with a combined checksum file.

## Generate a toy `.lif`
```bash
npm run generate:fixture
```

This writes `toy.lif` in the project root. Use **Import LIF files** in the app to load it.
The generated file is ignored by Git.

## Limitations (v1.4.5)
- Only supports 2D RGB, 8-bit, interleaved data (C=3)
- Elements with other formats are listed but show “Unsupported format (v1.4.5)”
- Spatial layout requires StageposX/StageposY metadata

## Contributing and License

Contributions are welcome through GitHub issues and pull requests. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, validation, and large-file
guidance.

LMDmapper is released under the [MIT License](LICENSE). If you use it in
research, please cite the archived release via its concept DOI
[10.5281/zenodo.20827562](https://doi.org/10.5281/zenodo.20827562), which always
resolves to the latest version. Citation metadata is provided in
[CITATION.cff](CITATION.cff).

## Notes
The parser expects an XML header (`LMSDataContainerHeader`) followed by raw mem block data.
It scans for `MemBlock_<id>` tokens (ASCII/UTF-16LE) and reads the expected number of bytes.
