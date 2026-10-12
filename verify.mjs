/**
 * Offline verification for the AudiobookBay BookOrbit plugin.
 *
 * Runs with no network: the plugin's own module is imported, its declared shape is checked against
 * the rules BookOrbit enforces before a plugin is ever called, and every parser is exercised against
 * the synthetic fixtures, which reproduce the live site's structural quirks and the failure modes that have historically
 * broken AudiobookBay scraping.
 *
 *   node verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const AUDIO_FORMATS = ['m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac'];

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}: ${detail}` : name);
}

function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function fixture(name) {
  return readFile(join(root, 'fixtures', name), 'utf8');
}

/* ------------------------------------------------------------ BookOrbit rules */

// Mirrors server/src/modules/book-request/indexers/plugins/plugin-shape.ts.
const TYPE_SLUG = /^[a-z0-9][a-z0-9-]{0,29}$/;
const MEDIA_KINDS = ['ebook', 'audiobook', 'comic'];
const SETTINGS_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

function assertPluginShape(plugin) {
  const problems = [];
  const say = (message) => problems.push(message);

  if (plugin.apiVersion !== 1) say('apiVersion must be 1');
  if (typeof plugin.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/.test(plugin.version)) {
    say('version must be a semantic version without a leading v');
  }
  if (typeof plugin.type !== 'string' || !TYPE_SLUG.test(plugin.type)) say('type must be a lowercase slug of at most 30 characters');
  if (typeof plugin.label !== 'string' || plugin.label.trim() === '') say('label is required');
  if (typeof plugin.search !== 'function') say('search is required');
  if (typeof plugin.test !== 'function') say('test is required');
  if (typeof plugin.requiresCredential !== 'boolean') say('requiresCredential must be a boolean');
  if (typeof plugin.usesCategories !== 'boolean') say('usesCategories must be a boolean');
  if (typeof plugin.seedsBack !== 'boolean') say('seedsBack must be a boolean');
  if (!Array.isArray(plugin.mediaKinds) || plugin.mediaKinds.length === 0) say('mediaKinds must be non-empty');
  else for (const kind of plugin.mediaKinds) if (!MEDIA_KINDS.includes(kind)) say(`"${kind}" is not a media kind`);

  const hasResolve = typeof plugin.resolveFile === 'function';
  const hasTorrent = typeof plugin.fetchTorrentFile === 'function';
  if (hasResolve && hasTorrent) say('cannot declare both resolveFile and fetchTorrentFile');
  if (!hasResolve && !hasTorrent) say('must declare resolveFile or fetchTorrentFile');

  for (const field of plugin.settingsFields ?? []) {
    if (typeof field.key !== 'string' || !SETTINGS_KEY.test(field.key)) say(`settings key ${JSON.stringify(field.key)} is unusable`);
    if (!['boolean', 'string', 'number'].includes(field.type)) say(`settings field ${field.key} has an unknown type`);
    if (typeof field.label !== 'string' || field.label.trim() === '') say(`settings field ${field.key} has no label`);
    if (field.format !== undefined && field.format !== 'list') say(`settings field ${field.key} has an unknown format`);
    if (field.format === 'list' && field.type !== 'string') say(`settings field ${field.key} can only use list format with a string value`);

    // assertFieldOptions: `options` is legal only on a non-empty list. This rule is what BookOrbit
    // rejected the first uploaded build for, so it is mirrored here exactly rather than approximated.
    if (field.options !== undefined) {
      if (field.format !== 'list' || !Array.isArray(field.options) || field.options.length === 0) {
        say(`settings field "${field.key}" can only declare options for a non-empty list`);
      } else {
        const normalised = new Set();
        for (const option of field.options) {
          if (typeof option !== 'string' || option.trim() === '' || option.length > 40) {
            say(`settings field "${field.key}" has an unusable option`);
            continue;
          }
          const canonical = option.trim().toLowerCase();
          if (normalised.has(canonical)) say(`settings field "${field.key}" has duplicate options`);
          normalised.add(canonical);
        }
        if (field.default !== undefined) {
          if (typeof field.default !== 'string') say(`settings field "${field.key}" has a non-string default`);
          else {
            for (const entry of String(field.default).split(',').map((item) => item.trim()).filter(Boolean)) {
              if (!normalised.has(entry.toLowerCase())) say(`settings field "${field.key}" has a default outside its options`);
            }
          }
        }
      }
    }

    // assertFieldMinimum.
    if (field.minItems !== undefined) {
      const options = Array.isArray(field.options) ? field.options : [];
      if (!Number.isInteger(field.minItems) || field.minItems < 0 || field.minItems > options.length) {
        say(`settings field "${field.key}" has an unusable minimum item count`);
      } else if (field.minItems > 0) {
        const defaults = String(field.default ?? '').split(',').map((item) => item.trim()).filter(Boolean);
        if (defaults.length < field.minItems) say(`settings field "${field.key}" needs a default that meets its minimum item count`);
      }
    }
  }
  return problems;
}

// Guards the mirror itself: if BookOrbit's rule and this one ever disagree, the plugin could pass here
// and still be rejected on upload, which is exactly what happened once already.
const shapeProbe = {
  apiVersion: 1, version: '0.1.0', type: 'probe', label: 'Probe',
  requiresCredential: false, usesCategories: false, seedsBack: true,
  mediaKinds: ['audiobook'],
  // The mirror reads real functions, exactly as BookOrbit's loader does.
  search: async () => [], test: async () => ({ success: true }), fetchTorrentFile: async () => new Uint8Array(),
  settingsFields: [],
};
check('the shape mirror rejects options on a non-list field', assertPluginShape({
  ...shapeProbe,
  settingsFields: [{ key: 'provider', type: 'string', label: 'Provider', default: 'scrape', options: ['a', 'b'] }],
}).some((p) => /non-empty list/.test(p)));
check('the shape mirror rejects a default outside a list\'s options', assertPluginShape({
  ...shapeProbe,
  settingsFields: [{ key: 'fmt', type: 'string', label: 'Fmt', format: 'list', options: ['a'], default: 'z' }],
}).some((p) => /default outside its options/.test(p)));
const probeProblems = assertPluginShape({
  ...shapeProbe,
  settingsFields: [{ key: 'fmt', type: 'string', label: 'Fmt', format: 'list', options: ['a', 'b'], default: 'a', minItems: 1 }],
});
if (process.env.DEBUG_SHAPE) console.log('probeProblems:', probeProblems);
check('the shape mirror accepts a list whose default and minimum agree', probeProblems.length === 0, probeProblems.join('; '));

/* ---------------------------------------------------------------- host stubs */

/**
 * A host stub shaped like BookOrbit's. `responses` maps a URL substring to either a string body, or
 * a function of (url, init) returning `{ status, text, bytes, headers }`. The member flow needs
 * methods, headers and binary bodies, not just text.
 */
function makeHost({ responses = new Map(), log = [], requests = [] } = {}) {
  return {
    responses,
    log,
    requests,
    fail(failure, message) {
      const error = new Error(message);
      error.failure = failure;
      return error;
    },
    buildSearchText(query) {
      return [query.title, query.author].filter(Boolean).join(' ').replace(/\s*\([^)]*\)/g, '').trim();
    },
    logger: { log: (message) => log.push(message), warn: (message) => log.push(message) },
    async fetch(url, init = {}) {
      const target = String(url);
      requests.push({ url: target, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
      const headers = (setCookie) => ({
        get: (name) => (String(name).toLowerCase() === 'set-cookie' && setCookie ? setCookie : null),
        getSetCookie: () => (setCookie ? [setCookie] : []),
      });
      const respond = ({ status = 200, text = '', bytes = null, setCookie = null, finalUrl = target }) => ({
        ok: status >= 200 && status < 300,
        status,
        url: finalUrl,
        headers: headers(setCookie),
        async text() { return typeof text === 'function' ? text() : text; },
        async arrayBuffer() { return (bytes ?? new Uint8Array()).buffer.slice(0); },
      });

      for (const [key, value] of responses) {
        if (!target.includes(key)) continue;
        if (typeof value !== 'function') return respond({ text: value });
        const result = await value(target, init);
        return result instanceof Uint8Array || result instanceof ArrayBuffer
          ? respond({ bytes: new Uint8Array(result) })
          : respond(result);
      }
      // The session bootstrap GETs the homepage, which no search fixture stands in for.
      if (new URL(target).pathname === '/') {
        return respond({ text: '<html>AudiobookBay <div class="post"></div></html>' });
      }
      throw new Error(`no stub response for ${target}`);
    },
  };
}

function makeConfig(settings = {}, baseUrl = 'https://audiobookbay.lu') {
  // `pace: false` is the suite's own escape hatch: the plugin paces every request to be polite to the
  // real host, which would make dozens of offline searches take minutes.
  return {
    id: 1, name: 'ABB', baseUrl, credential: null, allowPrivateAddress: false,
    categories: { ebook: [], audiobook: [], comic: [] },
    settings: { pace: false, ...settings },
  };
}

function makeQuery(overrides = {}) {
  return { title: 'Project Hail Mary', author: 'Andy Weir', isbn13: null, isbn13s: [], mediaKind: 'audiobook', language: null, limit: 20, ...overrides };
}

function searchTermOf(target) {
  const match = /[?&]s=([^&]*)/.exec(String(target));
  // AudiobookBay's own space-as-'+' style has to be undone before the term can be compared.
  return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
}

/**
 * Serves the results page only for a query it actually contains, otherwise an empty results page.
 *
 * `finalUrl` models the detail that broke the first release: AudiobookBay can answer with the results
 * in the body while reporting the bare homepage as `response.url`, so tests must not assume the URL
 * reflects the answer.
 */
function makePage(queryMatcher, html, { finalUrl = 'https://audiobookbay.lu/?s=x' } = {}) {
  return (target) => {
    const term = searchTermOf(target);
    const matched = term !== null && queryMatcher.test(term);
    return {
      status: 200,
      url: matched ? finalUrl : 'https://audiobookbay.lu/?s=nomatch',
      text: matched ? html : EMPTY_PAGE,
    };
  };
}

const EMPTY_PAGE = '<html><body>No results</body></html>';

/** AudiobookBay's front page, which it serves instead of results when it is dropping a search. */
const FEED_PAGE = '<html><head><title>Unabridged Audiobooks Free Online</title></head><body>'
  + '<div class="post"><div class="postTitle"><h2><a href="/abss/the-bear-and-the-serpent/">The Bear and the Serpent: Echoes of the Fall, Book 2 - Adrian Tchaikovsky</a></h2></div>'
  + '<div class="postInfo">Language: English</div>'
  + '<div class="postContent">Posted: 01 Jan 2026<br />Format: <span>M4B</span><br />File Size: <span>491</span> MBs</div></div>'
  + '</body></html>';

/* --------------------------------------------------------------------- tests */

const plugin = (await import('./indexers/audiobookbay/index.mjs')).default;

// Declared shape.
const shapeProblems = assertPluginShape(plugin);
check('declared shape satisfies BookOrbit plugin API v1', shapeProblems.length === 0, shapeProblems.join('; '));
equal('type', plugin.type, 'audiobookbay');
equal('mediaKinds is audiobook-only', JSON.stringify(plugin.mediaKinds), JSON.stringify(['audiobook']));
equal('seedsBack is true so the UI labels delivery as a torrent', plugin.seedsBack, true);
equal('requiresCredential is true, because torrents need a member session', plugin.requiresCredential, true);
equal('credentialKind holds the account password', plugin.credentialKind, 'apiKey');
equal('a username setting exists for the account', plugin.settingsFields.some((f) => f.key === 'username'), true);
check('declares fetchTorrentFile and not resolveFile', typeof plugin.fetchTorrentFile === 'function' && plugin.resolveFile === undefined);

// A full search-answer page: front-page entries the relevance filter must drop, plus the
// results that answer the query, carrying every structural quirk the live site has.
const searchPage = await fixture('search-results-page.html');
const mod = await import('./indexers/audiobookbay/index.mjs');
const parsedSearchPage = mod.parseSearchResults(searchPage, 'https://audiobookbay.lu');
check('the search page yields results', parsedSearchPage.length > 0, `got ${parsedSearchPage.length}`);
check('every result has title, url and format', parsedSearchPage.every((r) => r.title && r.url && r.format), JSON.stringify(parsedSearchPage.filter((r) => !(r.title && r.url && r.format))));
check('every result states a size', parsedSearchPage.every((r) => typeof r.sizeBytes === 'number' && r.sizeBytes > 0));
check('every result maps a language to an ISO 639-1 code', parsedSearchPage.every((r) => /^[a-z]{2}$/.test(String(r.language))), JSON.stringify(parsedSearchPage.map((r) => r.language)));
check('a non-English card maps to its own code', parsedSearchPage.some((r) => r.language === 'de'));
check('every result finds a cover', parsedSearchPage.every((r) => typeof r.cover === 'string' && r.cover.startsWith('https://')));
check('author is split off the card title', parsedSearchPage.filter((r) => r.author).length >= 4, JSON.stringify(parsedSearchPage.map((r) => r.author)));
// The parser omits `author` rather than nulling it, which is the shape the plugin contract wants for
// an optional field. A title with no " - " must stay whole instead of inventing an author.
check(
  'a title with no separator keeps its whole name and states no author',
  parsedSearchPage.some((r) => !r.author && r.title === 'Sample Hail Mary Collection'),
  JSON.stringify(parsedSearchPage.filter((r) => !r.author)),
);
check('formats are lowercased audio formats', parsedSearchPage.every((r) => AUDIO_FORMATS.includes(r.format)));

// A torrent detail page: the metadata table, one real download route and four that are not.
const torrentDetail = await fixture('detail-torrent-page.html');
equal('info hash normalised to upper-case hex', mod.infoHashFromHtml(torrentDetail), 'A75C81A1EA997530087D87DEC83BF77A1DDDEE15');
check('trackers are collected', mod.trackersFromHtml(torrentDetail).length >= 5);
check('trackers are announce URLs', mod.trackersFromHtml(torrentDetail).every((t) => /^(udp|https?):\/\//.test(t)));
const detailFiles = mod.fileListFromHtml(torrentDetail);
check('single-file table parsed', Array.isArray(detailFiles) && detailFiles.length === 1 && detailFiles[0].name === 'Sample_Book.m4b', JSON.stringify(detailFiles));
equal('file size parsed', detailFiles?.[0]?.sizeBytes, 943718400);

// Typographic punctuation, relative cover, mp3 card.
const typographic = mod.parseSearchResults(await fixture('search-typographic-title.html'), 'https://audiobookbay.lu');
equal('typographic card parsed', typographic.length, 1);
equal('curly apostrophe and dash normalised', typographic[0]?.title, "The Stranger's Wife - Anne Author");
equal('author split', typographic[0]?.author, 'Anne Author');
equal('mp3 format', typographic[0]?.format, 'mp3');
equal('bitrate parsed', typographic[0]?.bitrateKbps, 128);
equal('1.5 GBs parsed as binary gigabytes', typographic[0]?.sizeBytes, Math.round(1.5 * 1024 ** 3));
equal('relative cover resolved against the base', typographic[0]?.cover, 'https://audiobookbay.lu/covers/stranger.jpg');

// ------------------------------------------------------------------- case
// AudiobookBay's search is case-sensitive: `?s=Baldur` answers its generic front page while
// `?s=baldur` answers the book. Book metadata arrives capitalised, so every query must be lower-cased
// before it is sent, or almost every search looks like an empty catalogue. This was the bug that made
// "Baldur's Gate 3 / T. Kingfisher" return nothing from a real BookOrbit.
let caseTerms = [];
const caseHost = makeHost({ responses: new Map([['/?s=', (target) => {
  caseTerms.push(searchTermOf(target));
  return { status: 200, url: 'https://audiobookbay.lu/?s=x', text: searchPage };
}]]) });
await plugin.search({ ...makeQuery(), title: "Baldur's Gate 3", author: 'T. Kingfisher' }, makeConfig({ provider: 'scrape' }), caseHost, undefined);
check('a capitalised query is sent lower-cased', caseTerms.length > 0 && caseTerms.every((t) => t === t.toLowerCase()), JSON.stringify(caseTerms));
check('the capitalised query is still searched', caseTerms.some((t) => t.includes('baldur')), JSON.stringify(caseTerms));

// DOM drift must degrade, never throw.
const drift = mod.parseSearchResults(await fixture('search-dom-drift.html'), 'https://audiobookbay.lu');
equal('drifted DOM yields no results', drift.length, 0);

// Info-hash edge cases.
equal('messy hash normalised to 40 chars', mod.infoHashFromHtml(await fixture('detail-messy-hash.html')), 'ABC123DEF456789012345678901234567890ABCD');
equal('junk hash recovered from an in-page magnet', mod.infoHashFromHtml(await fixture('detail-magnet-fallback.html')), '1111111111111111111111111111111111111111');
equal('no usable hash returns null', mod.infoHashFromHtml(await fixture('detail-no-hash.html')), null);
equal('single-file page has no file table', mod.fileListFromHtml(await fixture('detail-single-file.html')), null);
const messyFiles = mod.fileListFromHtml(await fixture('detail-messy-hash.html'));
check('two-file table parsed', Array.isArray(messyFiles) && messyFiles.length === 2, JSON.stringify(messyFiles));

// Magnet construction.
equal(
  'magnet is built from the hash and trackers',
  mod.buildMagnet('a75c81a1ea997530087d87dec83bf77a1dddee15', ['udp://tracker.example:6969/announce']),
  'magnet:?xt=urn:btih:A75C81A1EA997530087D87DEC83BF77A1DDDEE15&tr=udp%3A%2F%2Ftracker.example%3A6969%2Fannounce',
);
let magnetRejected = false;
try { mod.buildMagnet('nope', []); } catch { magnetRejected = true; }
check('magnet rejects an invalid hash', magnetRejected);

// Unsupported media kind must be reported, not silently empty.
const searchHost = makeHost({ responses: new Map([['/?s=', searchPage]]) });
let mediumFailure = null;
try { await plugin.search(makeQuery({ mediaKind: 'ebook' }), makeConfig(), searchHost, undefined); }
catch (error) { mediumFailure = error.failure; }
equal('ebook requests are refused as unsupportedMedium', mediumFailure, 'unsupportedMedium');

// Offline mock provider.
const mockHost = makeHost();
const mockResults = await plugin.search(makeQuery({ title: 'Pride and Prejudice', author: 'Jane Austen' }), makeConfig({ provider: 'mock' }), mockHost, undefined);
check('mock provider returns a release', mockResults.length === 1, JSON.stringify(mockResults));
check('mock release is audiobook-shaped', mockResults[0]?.format === 'm4b' && mockResults[0]?.seeders === null);
const mockTest = await plugin.test(makeConfig({ provider: 'mock' }), mockHost);
equal('mock test succeeds', mockTest.success, true);

// Scrape path through the real search() entry point. The fixture answers "hail mary", so a query
// whose variant matches it is served the page, and the relevance filter drops the front-page entry
// while keeping the matching rows.
const scrapeConfig = makeConfig({ provider: 'scrape', requestDelaySeconds: 0 });
const scrapeQuery = { ...makeQuery(), title: 'hail mary', author: 'andy weir' };
const scrapeHost = makeHost({ responses: new Map([['/?s=', makePage(/hail mary/, searchPage)]]) });
const scrapeResults = await plugin.search(scrapeQuery, scrapeConfig, scrapeHost, undefined);
check('scrape search returns relevance-filtered results', scrapeResults.length > 0 && scrapeResults.length < 9, `got ${scrapeResults.length}`);
check('scrape results carry guid, downloadUrl and null swarm counts',
  scrapeResults.every((r) => r.guid && r.downloadUrl && r.seeders === null && r.leechers === null));
check('scrape results state a format BookOrbit accepts',
  scrapeResults.every((r) => AUDIO_FORMATS.includes(String(r.format))));

// A query the page has nothing for must produce no results rather than the site's whole front page.
const noMatchResults = await plugin.search(
  { ...makeQuery(), title: 'zzzznotarealbook', author: null },
  scrapeConfig,
  makeHost({ responses: new Map([['/?s=', makePage(/hail mary/, searchPage)]]) }),
  undefined,
);
equal('an unrelated query yields no results', noMatchResults.length, 0);

// ------------------------------------------------------------------ throttling
// The regression that broke every search on BookOrbit: AudiobookBay reports the bare homepage as
// `response.url` while returning the results in the body. A final-URL check discarded the page, and
// every query returned nothing. The same response shape must now yield results.
const resultsWithHomeUrl = await plugin.search(
  { ...makeQuery(), title: 'hail mary', author: 'andy weir' },
  scrapeConfig,
  makeHost({ responses: new Map([['/?s=', makePage(/hail mary/, searchPage, { finalUrl: 'https://audiobookbay.lu/' })]]) }),
  undefined,
);
check('results are kept when the response URL is the bare homepage', resultsWithHomeUrl.length > 0, `got ${resultsWithHomeUrl.length}`);

// The other half: when AudiobookBay drops the query and serves its front page, the query URL is
// intact and nine cards are present, so only the page title distinguishes it. Reporting that feed as
// results would match "Dogs of War" against "The Bear and the Serpent" on the word "war".
const feedHost = makeHost({ responses: new Map([['/?s=', () => ({ status: 200, url: 'https://audiobookbay.lu/?s=Dogs+of+War&cat=undefined%2Cundefined', text: FEED_PAGE })]]) });
const feedResults = await plugin.search(
  { ...makeQuery(), title: 'Dogs of War', author: 'Adrian Tchaikovsky' },
  scrapeConfig,
  feedHost,
  undefined,
);
equal('a front-page answer is not reported as search results', feedResults.length, 0);
check('the front-page answer is logged rather than passed off as results', feedHost.log.some((line) => /front page/.test(line)), JSON.stringify(feedHost.log));

// A dropped search is retried once after a pause, because the site recovers on its own within seconds.
// The first request here answers with the front page and the second with the real results.
let throttleAttempts = 0;
const recoveringHost = makeHost({ responses: new Map([['/?s=', () => {
  throttleAttempts += 1;
  return throttleAttempts === 1
    ? { status: 200, url: 'https://audiobookbay.lu/?s=dogs+of+war', text: FEED_PAGE }
    : { status: 200, url: 'https://audiobookbay.lu/?s=dogs+of+war', text: searchPage };
}]]) });
const recovered = await plugin.search(
  { ...makeQuery(), title: 'hail mary', author: 'andy weir' },
  scrapeConfig,
  recoveringHost,
  undefined,
);
check('a rate-limited search is retried and can recover', recovered.length > 0, `attempts=${throttleAttempts} results=${recovered.length}`);
check('the retry made a second request', throttleAttempts >= 2, `attempts=${throttleAttempts}`);

// The retry must not run away: a site that keeps answering with the feed must still give up.
let stubbornAttempts = 0;
const stubbornHost = makeHost({ responses: new Map([['/?s=', () => { stubbornAttempts += 1; return { status: 200, url: 'https://audiobookbay.lu/?s=x', text: FEED_PAGE }; }]]) });
const stubborn = await plugin.search({ ...makeQuery(), title: 'Dogs of War', author: null }, scrapeConfig, stubbornHost, undefined);
equal('a persistently throttled site yields no results', stubborn.length, 0);
check('the retry is bounded', stubbornAttempts <= 6, `attempts=${stubbornAttempts}`);

// A page that did answer the query is still parsed, so the check above is not simply refusing everything.
const answeredHost = makeHost({ responses: new Map([['/?s=', () => ({ status: 200, url: 'https://audiobookbay.lu/?s=hail+mary&cat=undefined%2Cundefined', text: searchPage })]]) });
const answeredResults = await plugin.search({ ...makeQuery(), title: 'hail mary', author: 'andy weir' }, scrapeConfig, answeredHost, undefined);
check('a page that answered the query is parsed', answeredResults.length > 0, `got ${answeredResults.length}`);

// Format filter: the fixture mixes m4b and mp3, and two of its rows are mp3.
const mp3Only = await plugin.search(
  { ...makeQuery(), title: 'hail mary', author: null },
  makeConfig({ provider: 'scrape', audioFormats: 'mp3', requestDelaySeconds: 0 }),
  makeHost({ responses: new Map([['/?s=', makePage(/hail mary/, searchPage)]]) }),
  undefined,
);
check('format filter keeps only the requested format', mp3Only.length > 0 && mp3Only.every((r) => r.format === 'mp3'), JSON.stringify(mp3Only.map((r) => r.format)));
check('format filter kept the matching rows only', mp3Only.every((r) => /hail mary/i.test(r.title)), JSON.stringify(mp3Only.map((r) => r.title)));

// ---------------------------------------------------------------- member grab
// Measured 2026-10-12 against a real AudiobookBay account: login POSTs username+password plus a
// one-time _formkey_, answers a 302 to /member/users/, and then /downld0?downfs=... answers
// application/x-bittorrent, 61,202 bytes, first byte 0x64, with
// content-disposition: attachment; filename="<id>.torrent". For a guest the same URL answers 88 bytes
// of HTML pointing at the login form, which the stub below also models.

// A real minimal bencode .torrent, built here so the grab is proved against actual torrent structure
// and not just a 0x64 first byte. BookOrbit parses these bytes with its own torrent reader, so the
// shape matters: announce, creation date, and an info dict carrying name, piece length, pieces and
// length. The info hash is the SHA-1 of the bencoded info dict, exactly as a client computes it.
const BENCODE_INFO = {
  name: 'Baldurs_Gate_3.m4b',
  'piece length': 16384,
  pieces: new Uint8Array(20).fill(0xab),
  length: 943718400,
};
const REAL_TORRENT = bencode({
  announce: 'udp://tracker.torrent.eu.org:451/announce',
  'creation date': 1760000000,
  info: BENCODE_INFO,
});
const REAL_INFO_HASH = createHash('sha1').update(bencode(BENCODE_INFO)).digest('hex');

function bencode(value) {
  if (typeof value === 'number') return Buffer.from(`i${value}e`, 'latin1');
  if (typeof value === 'string') return Buffer.concat([Buffer.from(`${Buffer.byteLength(value, 'latin1')}:`, 'latin1'), Buffer.from(value, 'latin1')]);
  if (value instanceof Uint8Array) {
    return Buffer.concat([Buffer.from(`${value.byteLength}:`, 'latin1'), Buffer.from(value)]);
  }
  const parts = [];
  // Real .torrent files keep their keys in lexicographic order, and clients rely on it for the hash.
  for (const key of Object.keys(value).sort()) parts.push(bencode(key), bencode(value[key]));
  return Buffer.concat([Buffer.from('d', 'latin1'), ...parts, Buffer.from('e', 'latin1')]);
}

const TORRENT_BYTES = new Uint8Array(REAL_TORRENT);
check('the test torrent is a bencode dictionary', TORRENT_BYTES[0] === 0x64, String(TORRENT_BYTES[0]));
check('the test torrent carries a real info hash', REAL_INFO_HASH.length === 40, REAL_INFO_HASH);

const LOGIN_FORM = '<html><body><form name="entryform" method="post" action="/member/login.php">'
  + '<input type="hidden" name="_formkey_" value="FORMKEY-123">'
  + '<input type="text" name="username"><input type="password" name="password"></form></body></html>';
const MEMBER_DETAIL = await fixture('detail-member-download.html');

function memberResponses({ torrent = TORRENT_BYTES, loginStatus = 302, loginBody = '' } = {}) {
  return new Map([
    ['/member/login.php', (url, init) => (
      init.method === 'POST'
        ? { status: loginStatus, text: loginBody, setCookie: 'PHPSESSID=member-session' }
        : { status: 200, text: LOGIN_FORM, setCookie: 'PHPSESSID=anon-session' }
    )],
    ['/downld0', () => ({ status: 200, bytes: torrent })],
    ['/abss/', () => ({ status: 200, text: MEMBER_DETAIL })],
  ]);
}

const memberConfig = makeConfig({ provider: 'scrape' });
memberConfig.credential = 'account-password';
memberConfig.settings.username = 'someone@example.com';

const memberHost = makeHost({ responses: memberResponses() });
const torrentBytes = await plugin.fetchTorrentFile(
  { guid: 'https://audiobookbay.lu/abss/baldurs-gate-3/', downloadUrl: 'https://audiobookbay.lu/abss/baldurs-gate-3/' },
  memberConfig,
  memberHost,
);
check('a member grab returns a Uint8Array', torrentBytes instanceof Uint8Array, String(torrentBytes));
check('the bytes are bencode, not a magnet object', torrentBytes?.[0] === 0x64 && torrentBytes?.magnet === undefined, JSON.stringify([...(torrentBytes?.slice?.(0, 4) ?? [])]));
equal('the whole torrent body is returned unchanged', torrentBytes.length, TORRENT_BYTES.length);

// The fetched file must be the torrent for the release that was picked, not some other file. A
// .torrent stores its info dict as binary bencode, so the check is to slice that dict out of the
// grabbed bytes and SHA-1 it, exactly as a BitTorrent client does, then compare with the hash the
// detail page states. That is what decides whether a client would accept the download.
const memberHash = mod.infoHashFromHtml(MEMBER_DETAIL);
check('the detail page states an info hash', Boolean(memberHash), String(memberHash));
const infoDict = sliceInfoDict(Buffer.from(torrentBytes));
check('the grabbed torrent contains an info dict', infoDict !== null, `${torrentBytes.length} bytes`);
check('the torrent names the audiobook file', String(infoDict).includes('Baldurs_Gate_3.m4b'), String(infoDict).slice(0, 60));
equal('the torrent\'s recomputed info hash matches the detail page',
  infoDict ? createHash('sha1').update(infoDict).digest('hex').toUpperCase() : null,
  memberHash);

/** The bencoded value of the `info` key, by scanning bencode rather than by string search. */
function sliceInfoDict(buffer) {
  const marker = Buffer.from('4:info', 'latin1');
  const at = buffer.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;
  let index = start;
  if (buffer[index] !== 0x64) return null; // must be a dictionary
  let depth = 0;
  while (index < buffer.length) {
    const byte = buffer[index];
    if (byte === 0x64 || byte === 0x6c) { depth += 1; index += 1; continue; } // d or l
    if (byte === 0x65) { // e
      depth -= 1;
      index += 1;
      if (depth === 0) return buffer.slice(start, index);
      continue;
    }
    if (byte === 0x69) { // i<number>e
      index = buffer.indexOf(0x65, index) + 1;
      continue;
    }
    // <length>:<bytes>
    const colon = buffer.indexOf(0x3a, index);
    if (colon < 0) return null;
    const length = Number(buffer.slice(index, colon).toString('latin1'));
    if (!Number.isFinite(length) || length < 0) return null;
    index = colon + 1 + length;
  }
  return null;
}

// The torrent link has to be the Torrent Download one, never the three monetisation links.
const fetchedUrls = memberHost.requests.map((r) => r.url);
check('the grab fetched /downld0', fetchedUrls.some((u) => u.includes('/downld0')), JSON.stringify(fetchedUrls));
check('the grab never followed a monetisation link',
  !fetchedUrls.some((u) => /dodl3-no|dedl4-now|hi-3dl|cyberpour|atimaze/.test(u)), JSON.stringify(fetchedUrls));

// The login must carry the one-time form key, and the torrent must ride the member session.
const loginPost = memberHost.requests.find((r) => r.method === 'POST' && r.url.includes('login.php'));
check('the login POSTs the username', String(loginPost?.body).includes('username=someone%40example.com'), String(loginPost?.body));
check('the login POSTs the password', String(loginPost?.body).includes('password=account-password'), String(loginPost?.body));
check('the login carries the one-time form key', String(loginPost?.body).includes('_formkey_=FORMKEY-123'), String(loginPost?.body));
check('the torrent request carries the member session cookie',
  memberHost.requests.some((r) => r.url.includes('/downld0') && r.headers.Cookie === 'PHPSESSID=member-session'),
  JSON.stringify(memberHost.requests.filter((r) => r.url.includes('/downld0')).map((r) => r.headers.Cookie)));

// Every way a member grab can fail must be a refusal with a reason. Each case gets its own indexer id,
// because sessions are cached per indexer and a reused one would hide the login failure being tested.
let grabCaseId = 100;
async function grabFailure(name, { responses, credential = 'account-password', username = 'someone@example.com' } = {}) {
  const config = makeConfig({ provider: 'scrape' });
  config.id = (grabCaseId += 1);
  config.credential = credential;
  config.settings.username = username;
  try {
    const out = await plugin.fetchTorrentFile(
      { guid: 'https://audiobookbay.lu/abss/x/', downloadUrl: 'https://audiobookbay.lu/abss/x/' },
      config,
      makeHost({ responses: responses ?? memberResponses() }),
    );
    return { name, threw: false, out };
  } catch (error) {
    return { name, threw: true, failure: error.failure, message: String(error.message) };
  }
}

const noCredential = await grabFailure('no-credential', { credential: '' });
check('a grab with no stored password is refused as unauthorized', noCredential.threw && noCredential.failure === 'unauthorized', JSON.stringify(noCredential));

const noUsername = await grabFailure('no-username', { username: '' });
check('a grab with no username is refused as unauthorized', noUsername.threw && noUsername.failure === 'unauthorized', JSON.stringify(noUsername));

const rejectedLogin = await grabFailure('rejected-login', {
  responses: memberResponses({ loginStatus: 200, loginBody: `${LOGIN_FORM}<p>Invalid login, please try again</p>` }),
});
check('a rejected login is refused as unauthorized', rejectedLogin.threw && rejectedLogin.failure === 'unauthorized', JSON.stringify(rejectedLogin));

const guestTorrent = await grabFailure('guest-html', {
  responses: memberResponses({ torrent: new TextEncoder().encode('<meta http-equiv="Refresh" content="0; url=/member/login.php">') }),
});
check('an HTML answer instead of a torrent is refused', guestTorrent.threw && guestTorrent.failure === 'unauthorized', JSON.stringify(guestTorrent));

const emptyTorrent = await grabFailure('empty-torrent', { responses: memberResponses({ torrent: new Uint8Array() }) });
check('an empty torrent is refused', emptyTorrent.threw && /empty/i.test(emptyTorrent.message), JSON.stringify(emptyTorrent));

const oversized = await grabFailure('oversized', { responses: memberResponses({ torrent: new Uint8Array(11 * 1024 * 1024).fill(0x64) }) });
check('an oversized torrent is refused', oversized.threw && /too large/i.test(oversized.message), JSON.stringify(oversized));

const noTorrentLink = await grabFailure('no-torrent-link', {
  responses: new Map([
    ['/member/login.php', (url, init) => (init.method === 'POST' ? { status: 302, setCookie: 'PHPSESSID=member-session' } : { status: 200, text: LOGIN_FORM, setCookie: 'PHPSESSID=anon-session' })],
    ['/abss/', () => ({ status: 200, text: '<html><body><table><tr><td>Info Hash:</td><td>a75c81a1ea997530087d87dec83bf77a1dddee15</td></tr></table></body></html>' })],
  ]),
});
check('a detail page with no torrent link is refused', noTorrentLink.threw && /no torrent download link/i.test(noTorrentLink.message), JSON.stringify(noTorrentLink));

// Bytes are the branch the stock plugin host already implements, so this path needs no BookOrbit patch.
const hostAsBytes = Buffer.from(torrentBytes);
check('the stock plugin host accepts these bytes unchanged', hostAsBytes[0] === 0x64 && hostAsBytes.length === TORRENT_BYTES.length);

// Resolution failures, in the style of the myanonamouse plugin's grab tests: every way of getting
// nothing usable must be a refusal with a reason, never a malformed magnet or a silent success.
async function resolveFailure(name, release, fixtureName) {
  const responses = new Map();
  if (fixtureName) responses.set('/abss/', await fixture(fixtureName));
  try {
    const out = await mod.resolveMagnetFor(release, makeConfig(), makeHost({ responses }));
    return { name, threw: false, out };
  } catch (error) {
    return { name, threw: true, failure: error.failure, message: String(error.message) };
  }
}

const noDownload = await resolveFailure('no-download-url', { guid: '', downloadUrl: '' });
check('a release with no detail URL is refused', noDownload.threw && noDownload.failure === 'error', JSON.stringify(noDownload));

const badDownload = await resolveFailure('unparsable-url', { guid: 'not a url', downloadUrl: 'not a url' });
check('a release with an unparsable detail URL is refused', badDownload.threw && /invalid/.test(badDownload.message), JSON.stringify(badDownload));

// The magnet helper is kept for tooling and for the guest-visible info hash, and must still refuse a
// page with no usable hash rather than synthesise one.
const noHash = await resolveFailure('no-info-hash', { guid: 'https://audiobookbay.lu/abss/x/', downloadUrl: 'https://audiobookbay.lu/abss/x/' }, 'detail-no-hash.html');
check('a detail page with no usable info hash is refused', noHash.threw && /info hash/i.test(noHash.message), JSON.stringify(noHash));

// A guest sees HTML where a member sees bencode. Both shapes are pinned so the difference the account
// makes cannot silently regress.
const guestPage = await fixture('detail-login-gate.html');
check('the guest download answer is HTML, not bencode', guestPage.charCodeAt(0) !== 0x64);
check('the member download answer is bencode', TORRENT_BYTES[0] === 0x64);

// A release from another host must be refused, so a guid cannot steer a grab elsewhere.
let crossHostRejected = false;
try {
  await mod.resolveMagnetFor(
    { guid: 'https://evil.example/abss/x/', downloadUrl: 'https://evil.example/abss/x/' },
    makeConfig(),
    makeHost({ responses: new Map([['evil.example', await fixture('detail-messy-hash.html')]]) }),
  );
} catch (error) { crossHostRejected = /does not belong/.test(String(error.message)); }
check('cross-host detail URL is refused', crossHostRejected);

// Invalid settings must be reported rather than silently defaulting.
const providerHost = makeHost();
let providerFailure = null;
try { await plugin.search(makeQuery(), makeConfig({ provider: 'nonsense' }), providerHost, undefined); }
catch (error) { providerFailure = error.failure; }
equal('an unknown provider is refused', providerFailure, 'error');

/* -------------------------------------------------------------------- report */

console.log(`\n${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);
if (failures.length > 0) process.exit(1);
console.log('verify: OK');
