/**
 * Developer-only live probe for the AudiobookBay plugin.
 *
 *   BOOKORBIT_ABB_BASE_URL=https://audiobookbay.lu \
 *   BOOKORBIT_ABB_QUERY="project hail mary" \
 *   node live-validate.mjs [--resolve-probe]
 *
 * Prints only structure: counts, field presence and lengths. Titles, hashes, trackers, magnets and
 * any URL carrying a token are never printed, and no file content is ever downloaded. `--resolve-probe`
 * fetches one detail page to confirm an info hash can be extracted without grabbing anything.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.BOOKORBIT_ABB_BASE_URL ?? 'https://audiobookbay.lu';
const query = process.env.BOOKORBIT_ABB_QUERY ?? 'project hail mary';
const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const plugin = (await import('./indexers/audiobookbay/index.mjs')).default;
const mod = await import('./indexers/audiobookbay/index.mjs');

const cookies = new Map();
function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function get(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml', ...(cookies.size ? { Cookie: cookieHeader() } : {}) },
    redirect: 'follow',
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return { response, html: await response.text() };
}

function encodeQuery(value) {
  return encodeURIComponent(String(value).trim()).replace(/%20/g, '+');
}

console.log(`live-validate: base=${baseUrl} query=${JSON.stringify(query)}`);
console.log('(output is redacted: no titles, hashes, trackers or magnets are printed)');

// Warm the session exactly as the plugin does.
const home = await get(new URL('/', baseUrl).href);
console.log(`homepage: HTTP ${home.response.status}, ${home.html.length} bytes, cookies=${cookies.size}`);

const searchUrl = `${new URL('/', baseUrl).href}?s=${encodeQuery(query)}&cat=undefined%2Cundefined`;
const search = await get(searchUrl);
console.log(`search: HTTP ${search.response.status}, ${search.html.length} bytes`);
console.log(`search final URL is the homepage (site rejected the query): ${search.response.url.replace(/\/+$/, '') === new URL('/', baseUrl).href.replace(/\/+$/, '')}`);

const parsed = mod.parseSearchResults(search.html, baseUrl);
console.log(`parsed releases: ${parsed.length}`);
const withField = (name) => parsed.filter((item) => item[name] !== null && item[name] !== undefined && item[name] !== '').length;
console.log(`  with url=${withField('url')} title=${withField('title')} author=${withField('author')} format=${withField('format')}`);
console.log(`  with sizeBytes=${withField('sizeBytes')} language=${withField('language')} bitrateKbps=${withField('bitrateKbps')} publishedAt=${withField('publishedAt')} cover=${withField('cover')}`);
console.log(`  formats seen: ${JSON.stringify([...new Set(parsed.map((item) => item.format))].sort())}`);
console.log(`  sample title length: ${parsed[0]?.title?.length ?? 0} chars`);

// Exercise the plugin entry point through the same host-shaped surface BookOrbit lends it.
const logs = [];
const host = {
  fail(failure, message) { const error = new Error(message); error.failure = failure; return error; },
  buildSearchText(q) { return [q.title, q.author].filter(Boolean).join(' ').replace(/\s*\([^)]*\)/g, '').trim(); },
  logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
  async fetch(url, init = {}) {
    const response = await fetch(url, { headers: init.headers, redirect: 'follow' });
    return response;
  },
};
const config = {
  id: 0, name: 'live-validate', baseUrl, credential: null, allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [], comic: [] },
  settings: { provider: 'scrape', requestDelaySeconds: 1, maxPages: 1 },
};
const releases = await plugin.search(
  { title: query, author: null, isbn13: null, isbn13s: [], mediaKind: 'audiobook', language: null, limit: 20 },
  config, host, undefined,
);
console.log(`plugin.search returned ${releases.length} candidates`);
console.log(`  log lines: ${JSON.stringify(logs)}`);
console.log(`  every candidate has a guid: ${releases.every((r) => typeof r.guid === 'string' && r.guid.startsWith(baseUrl))}`);
console.log(`  every candidate states an audio format: ${releases.every((r) => ['m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac'].includes(String(r.format)))}`);
console.log(`  swarm counts are null (never a false zero): ${releases.every((r) => r.seeders === null)}`);

const test = await plugin.test(config, host);
console.log(`plugin.test: success=${test.success}${test.error ? ` error=${test.error}` : ''}`);

// A member grab, when credentials are supplied. This is the real download path: it logs in, fetches
// the picked release's .torrent with that session, and checks the bytes are bencode. Reported as
// sizes and booleans only, never as the bytes or the magnet.
const memberUser = process.env.BOOKORBIT_ABB_USER ?? '';
const memberPass = process.env.BOOKORBIT_ABB_PASS ?? '';
if (memberUser && memberPass) {
  const memberConfig = {
    ...config,
    credential: memberPass,
    settings: { ...config.settings, username: memberUser },
  };
  const target = releases[0];
  if (!target) {
    console.log('member grab: no candidate to grab');
  } else {
    try {
      const bytes = await plugin.fetchTorrentFile(target, memberConfig, host);
      const isBencode = bytes instanceof Uint8Array && bytes[0] === 0x64;
      console.log(`member grab: OK, ${bytes.byteLength} bytes, bencode=${isBencode}`);
      // A .torrent embeds the info hash in plain sight; comparing it to the detail page proves the
      // file matches the release that was picked rather than being some other torrent.
      const asText = Buffer.from(bytes).toString('latin1');
      const detailHash = mod.infoHashFromHtml((await get(target.downloadUrl)).html);
      const hashMatches = Boolean(detailHash) && asText.includes(Buffer.from(detailHash, 'hex').toString('latin1'));
      console.log(`member grab: info hash matches the detail page = ${hashMatches}`);
    } catch (error) {
      console.log(`member grab: FAILED ${error?.failure ?? ''} ${String(error?.message ?? error)}`);
    }
  }
} else {
  console.log('member grab: skipped (set BOOKORBIT_ABB_USER and BOOKORBIT_ABB_PASS to exercise it)');
}

if (process.argv.includes('--resolve-probe')) {
  const target = releases[0]?.downloadUrl;
  if (!target) {
    console.log('resolve probe: no candidate to probe');
  } else {
    const detail = await get(target);
    const hash = mod.infoHashFromHtml(detail.html);
    const trackers = mod.trackersFromHtml(detail.html);
    const files = mod.fileListFromHtml(detail.html);
    console.log(`resolve probe: HTTP ${detail.response.status}, hash present=${Boolean(hash)} hash length=${hash?.length ?? 0}, trackers=${trackers.length}, file-table entries=${files?.length ?? 'none'}`);
    console.log('resolve probe: no file content was downloaded');
  }
}

// Confirm the offline fixture still parses, so a regression in the parser is visible here too.
try {
  const fixtureHtml = await readFile(join(root, 'fixtures', 'search-results-page.html'), 'utf8');
  const fixtureParsed = mod.parseSearchResults(fixtureHtml, baseUrl);
  console.log(`fixture regression: the synthetic search fixture still parses to ${fixtureParsed.length} releases`);
} catch {
  console.log('fixture regression: search fixture missing');
}
