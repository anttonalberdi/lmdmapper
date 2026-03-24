# Copilot instructions for this repository

Purpose
- Help AI coding agents be productive quickly: architecture, workflows, IPC surface, and repo-specific patterns.

Big picture
- Electron app with a Vite + React renderer and a Node/Electron main process. Renderer UI lives in `src/renderer`, main logic in `src/main`, shared types in `src/shared`.
- Renderer bundles via Vite into `dist/`; main TS is compiled to `dist-electron/` and packaged by `electron-builder`.

Key files and responsibilities
- `src/main/main.ts`: Electron lifecycle, `BrowserWindow` config (contextIsolation, sandbox), and IPC handlers.
- `src/main/preload.ts`: Exposes a minimal `lifApi` via `contextBridge` (see `openFile`, `parseFile`, `loadImage`).
- `src/main/lif.ts`: Core .lif parsing, binary scanning and caching logic — important for performance and correctness.
- `src/renderer/App.tsx`: UI; calls `window.lifApi` and handles image decoding/display.
- `src/shared/lifTypes.ts`: Shared TypeScript types used across renderer/main — prefer updating these when changing IPC payloads.

IPC surface (explicit examples)
- Channels implemented in `main.ts`:
  - `lif:openFile` -> opens file dialog and returns path or `null`.
  - `lif:parseFile` -> returns `LifParseResponse` (see `src/shared/lifTypes.ts`), or `{ error: string }`.
  - `lif:loadImage` -> returns `LifImageResponse` with binary image `data` or `{ elementId, error }`.

Important repo patterns & conventions
- Safe preload pattern: `contextBridge.exposeInMainWorld('lifApi', api)` in `src/main/preload.ts`. Use this exact API surface from renderer — do not access Node/Electron directly from renderer.
- Shared types: use `@shared/*` import alias (configured in `tsconfig.json` and `vite.config.ts`). Example: `import type { LifElement } from '@shared/lifTypes'`.
- Main build: TypeScript for main is compiled to `dist-electron` using `tsc -p tsconfig.main.json`; `package.json` sets `main` to `dist-electron/main/main.js`.
- Binary parsing in `src/main/lif.ts`:
  - XML header extraction reads up to `MAX_HEADER_BYTES` and looks for `<LMSDataContainerHeader>..</LMSDataContainerHeader>`.
  - Memory block discovery scans for ASCII `MemBlock_` tokens and computes data offsets tolerant to size prefixes or padding.
  - The parser marks elements with `supported: boolean` using width/height/channels/resolution and memory size checks; UI relies on `supported` to show "RGB 8-bit" vs unsupported.

Developer workflows (exact commands)
- Start development (renderer hot-reload + main watch + electron):
  - `npm run dev` — this runs `dev:renderer` (vite), `dev:main` (tsc --watch) and `dev:electron` (waits for Vite, then runs electron).
- Build a distributable:
  - `npm run build` — runs `vite build`, `tsc -p tsconfig.main.json`, then `electron-builder`.
- Lint: `npm run lint`.
- Generate an example .lif fixture: `npm run generate:fixture` (runs `scripts/generate-toy-lif.js`).

Debugging notes
- To debug renderer code, run `npm run dev` and use the DevTools opened by `main.ts` when `VITE_DEV_SERVER_URL` is set.
- If preload API is missing in the renderer, check `src/main/preload.ts` and BrowserWindow options in `src/main/main.ts` (preload path and `contextIsolation`/`sandbox`).

Packaging and outputs
- `electron-builder` configuration sits in `package.json` `build` section. Output is written to `release/` and expects `dist/` and `dist-electron/` to be present.

What to watch for when editing
- Changing IPC payloads: update `src/shared/lifTypes.ts` and both sides (preload/main handler and renderer usage).
- Performance-sensitive code: `src/main/lif.ts` uses streaming reads, chunk sizes, and a cache map. If you change buffer logic, validate on large `.lif` files.
- Path aliases: maintain `@shared` mapping in `tsconfig.json` and `vite.config.ts` if you refactor `src/shared`.

If anything here is unclear or you'd like me to add run/example debug steps (e.g., how to open DevTools, reproduce a parsing error), tell me which area to expand.
