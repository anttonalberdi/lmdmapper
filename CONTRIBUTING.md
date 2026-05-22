# Contributing

Thank you for improving LMDmapper. This repository is intended to stay cloneable,
buildable, and auditable, so source code and documentation belong in GitHub while
large generated artifacts stay out of Git history.

## Development setup

```bash
git clone https://github.com/anttonalberdi/lmdmapper.git
cd lmdmapper
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm run lint
npm run build:renderer
npm run build:main
```

`npm run build` creates packaged desktop artifacts in `release/`. Those files are
local release outputs and must not be committed.

## Large files and local data

Do not commit generated installers, build caches, raw microscopy data, local
session files, or files that contain local filesystem paths or laboratory data.
The repository ignores `release/`, `.cache/`, generated `.lif` files, and local
`.lmd` / `.mlmd` session files by default.

If a public example dataset is added later, use synthetic or explicitly
de-identified data and keep large files outside the Git repository.

## Pull requests

Keep changes focused and include a short description of the workflow or bug being
changed. For parser, coordinate, import/export, or session-format changes, add a
manual reproduction note or test fixture description so reviewers can verify the
behavior.
