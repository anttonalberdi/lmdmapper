# Release with Zenodo

Use this checklist when publishing a LMDmapper release that should include
source code, built desktop artifacts, checksums, and a citable archive.

## 1. Prepare the release locally

1. Create or update `release-notes/<version>.md`.
2. Run the release preparation script:

```bash
npm run release:build -- --version <x.y.z>
```

On macOS, the local script builds macOS x64/arm64 and Windows x64/arm64/ia32
artifacts. On Windows it builds Windows artifacts. On Linux it builds Linux
x64/arm64 artifacts. The script writes checksums for all artifacts it produced
to `release/SHA256SUMS-<version>.txt`.

## 2. Publish the GitHub release

Push a tag named `v<x.y.z>`:

```bash
git tag v<x.y.z>
git push origin v<x.y.z>
```

The `Release` GitHub Actions workflow builds and publishes these assets:

| System | Architectures | Artifacts |
| --- | --- | --- |
| macOS | x64, arm64 | DMG, ZIP |
| Windows | x64, arm64, ia32 | NSIS installer, ZIP |
| Linux | x64, arm64 | AppImage, DEB, RPM, tar.gz |

The workflow also uploads `SHA256SUMS-<version>.txt` for the full combined
release asset set. Linux x64 and arm64 artifacts are built on separate native
GitHub runners to avoid cross-architecture AppImage packaging problems.

## 3. Archive on Zenodo

1. Confirm the GitHub release contains the source archive, all expected built
   artifacts, and the combined checksum file.
2. Let Zenodo archive the tagged GitHub release.
3. Add the Zenodo DOI to `CITATION.cff`, the README, and the manuscript before
   final submission.
4. Keep the GitHub release notes and Zenodo description aligned so users can
   identify the correct artifact for their operating system and CPU.
