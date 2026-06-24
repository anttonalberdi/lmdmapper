#!/usr/bin/env node

/**
 * Archive a LMDmapper release to Zenodo.
 *
 * Uploads the files in --dir to Zenodo and publishes the deposition, minting a
 * DOI. If ZENODO_CONCEPT_RECID is set, a new *version* of that existing record
 * is created (so every release shares one stable "concept" DOI and gets its own
 * per-version DOI). Otherwise a fresh record is created and its concept recid is
 * printed so it can be stored for subsequent releases.
 *
 * Metadata is read from .zenodo.json at the repository root; the version and
 * publication date are injected from package.json / the current date.
 *
 * Environment:
 *   ZENODO_TOKEN          (required) Zenodo personal access token.
 *   ZENODO_CONCEPT_RECID  (optional) Concept record id of an existing deposit.
 *   ZENODO_BASE           (optional) API host. Default https://zenodo.org.
 *                         Use https://sandbox.zenodo.org for testing.
 *
 * Usage:
 *   node scripts/zenodo-publish.js --dir <folder-with-release-files> [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { dir: '', dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dir') {
      options.dir = args[i + 1] ?? '';
      i += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/zenodo-publish.js --dir <folder> [--dry-run]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.dir) {
    throw new Error('Missing required --dir <folder-with-release-files>');
  }
  return options;
};

const BASE = (process.env.ZENODO_BASE || 'https://zenodo.org').replace(/\/$/, '');
const TOKEN = process.env.ZENODO_TOKEN || '';
const CONCEPT = (process.env.ZENODO_CONCEPT_RECID || '').trim();

const authHeader = () => ({ Authorization: `Bearer ${TOKEN}` });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

const api = async (method, url, { json, body, headers } = {}) => {
  const fullUrl = url.startsWith('http') ? url : `${BASE}${url}`;
  const buildInit = () => {
    const init = { method, headers: { ...authHeader(), ...(headers || {}) } };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }
    return init;
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(fullUrl, buildInit());
    } catch (networkError) {
      // Network-level failure (e.g. "fetch failed" / socket hang up). Retry.
      lastError = networkError;
      if (attempt < MAX_ATTEMPTS) {
        const wait = 2000 * 2 ** (attempt - 1);
        console.log(`  network error on ${method} ${fullUrl} (attempt ${attempt}); retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw new Error(`Zenodo ${method} ${fullUrl} failed after ${MAX_ATTEMPTS} attempts: ${networkError.message || networkError}`);
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (res.ok) {
      return parsed;
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      const wait = 2000 * 2 ** (attempt - 1);
      console.log(`  HTTP ${res.status} on ${method} ${fullUrl} (attempt ${attempt}); retrying in ${wait / 1000}s`);
      await sleep(wait);
      lastError = new Error(`HTTP ${res.status}`);
      continue;
    }
    throw new Error(
      `Zenodo ${method} ${fullUrl} -> ${res.status} ${res.statusText}\n${JSON.stringify(parsed, null, 2)}`
    );
  }
  throw lastError;
};

const loadMetadata = (version) => {
  const file = path.join(ROOT, '.zenodo.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.version = version;
  meta.publication_date = new Date().toISOString().slice(0, 10);
  return meta;
};

const listFiles = (dir) => {
  const abs = path.resolve(ROOT, dir);
  const entries = fs
    .readdirSync(abs)
    .filter((name) => fs.statSync(path.join(abs, name)).isFile())
    .sort();
  if (!entries.length) {
    throw new Error(`No files found to upload in ${abs}`);
  }
  return entries.map((name) => ({ name, fullPath: path.join(abs, name) }));
};

const uploadFile = async (bucketUrl, file) => {
  const data = fs.readFileSync(file.fullPath);
  await api('PUT', `${bucketUrl}/${encodeURIComponent(file.name)}`, {
    body: data,
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  console.log(`  uploaded ${file.name} (${(data.length / 1e6).toFixed(1)} MB)`);
};

const main = async () => {
  const options = parseArgs();
  if (!TOKEN) {
    throw new Error('ZENODO_TOKEN is not set');
  }

  const version = require(path.join(ROOT, 'package.json')).version;
  const metadata = loadMetadata(version);
  const files = listFiles(options.dir);

  console.log(`Zenodo host : ${BASE}`);
  console.log(`Version     : ${version}`);
  console.log(`Concept rec : ${CONCEPT || '(none — creating a fresh record)'}`);
  console.log(`Files       : ${files.length}`);
  files.forEach((f) => console.log(`  - ${f.name}`));

  if (options.dryRun) {
    console.log('\n--dry-run: not contacting Zenodo.');
    console.log('\nMetadata that would be submitted:');
    console.log(JSON.stringify({ metadata }, null, 2));
    return;
  }

  // Obtain a draft deposition: either a new version of an existing concept,
  // or a brand-new record.
  let deposition;
  if (CONCEPT) {
    console.log('\nResolving latest published version of concept...');
    const latest = await api('GET', `/api/records/${CONCEPT}`);
    const latestId = latest.id;
    console.log(`Latest version record id: ${latestId}`);
    const newVersion = await api(
      'POST',
      `/api/deposit/depositions/${latestId}/actions/newversion`
    );
    const draftUrl = newVersion.links.latest_draft;
    deposition = await api('GET', draftUrl);
    // A new version inherits the previous version's files; remove them so the
    // record holds only this release's artifacts.
    for (const existing of deposition.files || []) {
      await api('DELETE', `/api/deposit/depositions/${deposition.id}/files/${existing.id}`);
      console.log(`  removed inherited file ${existing.filename}`);
    }
  } else {
    deposition = await api('POST', '/api/deposit/depositions', { json: {} });
  }

  const bucketUrl = deposition.links.bucket;
  console.log(`\nDeposition id: ${deposition.id}`);
  console.log('Uploading files...');
  for (const file of files) {
    await uploadFile(bucketUrl, file);
  }

  console.log('\nSetting metadata...');
  await api('PUT', `/api/deposit/depositions/${deposition.id}`, { json: { metadata } });

  console.log('Publishing...');
  const published = await api(
    'POST',
    `/api/deposit/depositions/${deposition.id}/actions/publish`
  );

  const doi = published.doi || published.metadata?.doi;
  const conceptRecid = published.conceptrecid;
  const conceptDoi = published.conceptdoi || published.metadata?.conceptdoi;
  const htmlUrl = published.links?.record_html || published.links?.html;

  console.log('\n=== Zenodo publish complete ===');
  console.log(`Version DOI   : ${doi}`);
  console.log(`Concept DOI   : ${conceptDoi || '(n/a)'}`);
  console.log(`Concept recid : ${conceptRecid}`);
  console.log(`Record URL    : ${htmlUrl}`);
  if (!CONCEPT) {
    console.log(
      `\nIMPORTANT: store this concept recid as the repo variable ZENODO_CONCEPT_RECID\n` +
        `so future releases chain as new versions:\n  ${conceptRecid}`
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version_doi=${doi}\nconcept_doi=${conceptDoi || ''}\nconcept_recid=${conceptRecid}\nrecord_url=${htmlUrl}\n`
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Zenodo archive\n\n` +
        `- Version DOI: ${doi}\n` +
        `- Concept DOI: ${conceptDoi || '(n/a)'}\n` +
        `- Concept recid: \`${conceptRecid}\`\n` +
        `- Record: ${htmlUrl}\n`
    );
  }
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
