/**
 * BookOrbit API v1 indexer for AudiobookBay (audiobookbay.lu).
 *
 * AudiobookBay distributes audiobooks as BitTorrent releases. Its search and detail pages are
 * readable anonymously; the download itself is not. The scraping rules here are ported from
 * shelfmark's AudiobookBay source, whose non-obvious behaviours are load bearing:
 *
 *  - WordPress texturises titles on output but ABB searches the stored, non-texturised text, and it
 *    ANDs its terms. A curly apostrophe in a query therefore matches nothing at all, so queries and
 *    compared titles are mapped back to ASCII first.
 *  - ABB hands out a PHPSESSID and increasingly answers reliably only once it is warmed, so a
 *    session is bootstrapped with a homepage GET. A search that redirects to the homepage means the
 *    site rejected it, which is not the same as "no results".
 *  - The Info Hash cell can arrive lowercase and split across lines. It is stripped and upper-cased
 *    before validation, with an in-page magnet link as fallback.
 */

const VERSION = '0.1.0';
const UPDATE_CHANNEL = null; // scripts/sign-update.mjs fills this with the publisher's public key and URL.
const TYPE = 'audiobookbay';

/** Audio formats BookOrbit can import and play (scanner/lib/classify.ts AUDIO_FORMATS). */
const AUDIO_FORMATS = ['m4b', 'mp3', 'm4a', 'opus', 'ogg', 'flac'];
const MOCK_RELEASES = [{
  guid: 'https://audiobookbay.lu/abss/mock-pride-and-prejudice/',
  title: 'Pride and Prejudice - Jane Austen',
  author: 'Jane Austen',
  format: 'm4b',
  sizeBytes: 750000000,
  language: 'en',
}];

/**
 * Applied when a detail page states no trackers of its own. Kept short and well known: the magnet
 * still carries the info hash, which is the only part that identifies the torrent.
 */
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
];

const SEARCH_STRATEGIES = ['title-author', 'title-only'];
const PROVIDERS = ['scrape', 'mock'];
const MAX_PAGES = 10;
const SEARCH_PAGE_ATTEMPTS = 2;
// A dropped search is retried once after a pause: the site recovers on its own within seconds, and a
// second request a moment later is far likelier to be answered than an immediate one.
const THROTTLE_RETRY_ATTEMPTS = 1;
const THROTTLE_RETRY_DELAY_MS = 2000;
// The pace of requests to AudiobookBay. Measured 2026-10-12: single requests a few seconds apart are
// answered indefinitely, while requests arriving back to back make the site answer its generic front
// page instead of results. A low setting does not make searches faster, it makes them come back empty.
const MIN_REQUEST_DELAY_SECONDS = 1;
const DEFAULT_REQUEST_DELAY_SECONDS = 1;
const MAX_REQUEST_DELAY_SECONDS = 10;
const USER_AGENT = 'BookOrbit audiobookbay plugin';

/** WordPress "texturized" punctuation mapped back to the ASCII forms ABB actually stores. */
const ASCII_PUNCTUATION = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '\u00b4': "'", '`': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u2033': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-',
  '\u2212': '-', '\ufe58': '-', '\ufe63': '-', '\uff0d': '-',
  '\u2026': '...',
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...',
  mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
};

const sessions = new Map();

const mockProvider = {
  async search(query, _config, host, options) {
    const isbn = cleanIsbn(query.isbn13);
    const text = host.buildSearchText(query).toLowerCase();
    return MOCK_RELEASES.filter((item) => options.formats.includes(item.format) && (
      (isbn && item.isbn === isbn) ||
      (query.title && text.includes('pride and prejudice') &&
        (!query.author || text.includes('jane austen')))
    )).slice(0, Math.max(0, query.limit ?? 20)).map((item) => ({
      guid: item.guid, title: item.title, bookTitle: 'Pride and Prejudice',
      author: item.author, format: item.format, sizeBytes: item.sizeBytes,
      seeders: null, leechers: null, language: item.language, primaryFileCount: 1,
    }));
  },
  async test() { return { success: true, indexerName: 'AudiobookBay (offline mock)' }; },
  async fetchTorrentFile(release, _config, host) {
    const item = MOCK_RELEASES.find((entry) => entry.guid === release.guid);
    if (!item) throw host.fail('error', 'unknown test release');
    throw host.fail('error', 'the offline mock provides no torrent data');
  },
};

const scrapeProvider = {
  async search(query, config, host, options) {
    const signal = options.signal;
    const isbn = cleanIsbn(query.isbn13);
    if (isbn) host.logger.log('[audiobookbay.search] an ISBN was supplied but AudiobookBay has no ISBN search');
    const candidates = queryCandidates(query, config, host, options.strategy);
    if (candidates.length === 0) return [];
    const session = await openSession(config, host, signal);
    for (let index = 0; index < candidates.length; index += 1) {
      // BookOrbit hands each indexer a deadline (20s by default) and aborts the signal when it expires,
      // so the fallbacks stop as soon as the caller stops waiting. Returning what was found beats
      // running on and being discarded entirely.
      if (signal?.aborted) {
        host.logger.warn('[audiobookbay.search] the search deadline passed before an answer was found; returning no results');
        return [];
      }
      const releases = await searchAllPages(
        candidates[index],
        limit(query.limit),
        config,
        host,
        // A server error is retried on the first candidate only, where the answer actually matters.
        index === 0 ? { ...options, retryServerErrors: true } : options,
        session,
      );
      if (releases.length > 0) return releases;
    }
    return [];
  },
  async test(config, host) {
    try {
      const response = await request(config, host, '/', { signal: undefined });
      const html = await response.text();
      if (!looksLikeAudiobookBay(html)) {
        return { success: false, error: 'the base URL answered but does not look like AudiobookBay' };
      }
      return { success: true, indexerName: 'AudiobookBay' };
    } catch (error) {
      return { success: false, error: String(error?.message ?? 'AudiobookBay could not be reached') };
    }
  },
  /**
   * Fetches the picked release's `.torrent` file with the member session.
   *
   * AudiobookBay serves its torrents only to a logged-in account: for a guest the download link
   * answers an 88-byte HTML page pointing at the login form, and for a member it answers the real
   * bencode file. So this needs a credential, and it returns bytes rather than a magnet, which means
   * no BookOrbit-side change is needed for a grab to work.
   */
  async fetchTorrentFile(release, config, host) {
    return fetchMemberTorrent(release, config, host);
  },
};

export default {
  apiVersion: 1,
  version: VERSION,
  ...(UPDATE_CHANNEL ? { update: UPDATE_CHANNEL } : {}),
  type: TYPE,
  label: 'AudiobookBay',
  // AudiobookBay serves its `.torrent` files only to a logged-in account, so a grab needs one.
  requiresCredential: true,
  // BookOrbit's credential field holds the AudiobookBay account password; the username is a setting.
  credentialKind: 'apiKey',
  mediaKinds: ['audiobook'],
  supportsIsbnSearch: false,
  usesCategories: false,
  // AudiobookBay releases are torrents, so a grab joins a swarm and seeds back.
  seedsBack: true,
  defaultBaseUrl: 'https://audiobookbay.lu',
  baseUrlHint: 'AudiobookBay mirror to search. Mock mode works offline.',
  settingsFields: [
    {
      key: 'username', type: 'string', label: 'AudiobookBay username', default: '',
      hint: 'The email or username for your AudiobookBay account. Its password goes in the API key field.',
    },
    {
      // A plain text field: BookOrbit only lets a field declare `options` when its format is `list`,
      // so a single-choice setting has to state its allowed values in the hint instead.
      key: 'provider', type: 'string', label: 'Provider', default: 'scrape',
      hint: 'scrape for the live site, or mock for offline testing. Anything else is refused.',
    },
    {
      key: 'searchStrategy', type: 'string', label: 'Search strategy', default: 'title-author',
      hint: 'title-author tries the decorated query, then title plus author, then title alone. title-only never sends the author. Anything else is refused.',
    },
    {
      key: 'audioFormats', type: 'string', label: 'Audio formats',
      default: 'm4b,mp3,m4a,flac',
      format: 'list', options: AUDIO_FORMATS, minItems: 1,
    },
    { key: 'maxPages', type: 'number', label: 'Max search pages', default: 1, hint: `1-${MAX_PAGES}.` },
    { key: 'exactPhrase', type: 'boolean', label: 'Prefer exact phrase', default: false, hint: 'Quotes the query. AudiobookBay ANDs its terms, so this is strict.' },
    {
      key: 'requestDelaySeconds', type: 'number', label: 'Delay between requests (seconds)',
      default: DEFAULT_REQUEST_DELAY_SECONDS,
      hint: `1-${MAX_REQUEST_DELAY_SECONDS}. AudiobookBay throttles on bursts and answers its front page instead of results, so this paces every request. Raising it is the fix when searches come back empty.`,
    },
  ],

  async search(query, config, host, signal) {
    if (query.mediaKind !== 'audiobook') throw host.fail('unsupportedMedium', 'AudiobookBay only serves audiobooks');
    if (signal?.aborted) return [];
    const options = readOptions(config, host);
    options.signal = signal;
    const releases = await provider(config, host).search(query, config, host, options);
    host.logger.log(`[audiobookbay.search] found=${releases.length}`);
    return releases;
  },

  async test(config, host) {
    try { return await provider(config, host).test(config, host); }
    catch { return { success: false, error: 'Invalid provider configuration' }; }
  },

  async fetchTorrentFile(release, config, host) {
    return provider(config, host).fetchTorrentFile(release, config, host);
  },
};

/** Exposed for tests and for tooling that wants the magnet without performing a grab. */
export async function resolveMagnetFor(release, config, host) {
  return resolveMagnet(release, config, host, undefined);
}

/* ------------------------------------------------------------------ options */

function readOptions(config, host) {
  const settings = config.settings ?? {};
  const provider = String(settings.provider ?? 'scrape').trim().toLowerCase();
  if (!PROVIDERS.includes(provider)) throw host.fail('error', 'provider must be scrape or mock');
  const strategy = String(settings.searchStrategy ?? 'title-author').trim().toLowerCase();
  if (!SEARCH_STRATEGIES.includes(strategy)) throw host.fail('error', 'searchStrategy must be title-author or title-only');
  const formats = list(settings.audioFormats ?? AUDIO_FORMATS.join(',')).filter((value) => AUDIO_FORMATS.includes(value));
  if (formats.length === 0) throw host.fail('unsupportedMedium', 'no supported audio formats are configured');
  return {
    provider,
    strategy,
    formats,
    exactPhrase: settings.exactPhrase === true || settings.exactPhrase === 'true',
    maxPages: clampInt(settings.maxPages, 1, MAX_PAGES, 1),
    // Every request to the host is paced by this, not just a page turn. Measured 2026-10-12:
    // AudiobookBay answers single requests spaced a few seconds apart indefinitely, and answers its
    // generic front page instead of results when several arrive back to back. A minimum is enforced
    // because a low value does not make searches faster, it makes them come back empty.
    delayMs: clampInt(settings.requestDelaySeconds, MIN_REQUEST_DELAY_SECONDS, MAX_REQUEST_DELAY_SECONDS, DEFAULT_REQUEST_DELAY_SECONDS) * 1000,
    // Test-only. The offline suite drives dozens of searches and would otherwise spend minutes waiting
    // out a delay that exists to be polite to a real host.
    pace: settings.pace !== false,
  };
}

/**
 * The pace of requests to AudiobookBay, as a per-host timestamp.
 *
 * The site throttles on bursts, and a burst is exactly what a search produces: a session bootstrap, a
 * candidate query, and a retry after a dropped answer. Spacing only the candidates would leave the
 * rest back to back, so the wait belongs here, in the one place every request goes through.
 */
const lastRequestAt = new Map();

async function pace(key, delayMs, signal) {
  const wait = (lastRequestAt.get(key) ?? 0) + delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  if (signal?.aborted) throw new Error('aborted');
  lastRequestAt.set(key, Date.now());
}

function provider(config, host) {
  return readOptions(config, host).provider === 'mock' ? mockProvider : scrapeProvider;
}

function list(value) {
  return String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function limit(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(50, Math.trunc(parsed));
}

function cleanIsbn(value) {
  return String(value ?? '').replace(/[^0-9X]/gi, '').toUpperCase();
}

/* ------------------------------------------------------------------- queries */

function normalizeSearchPunctuation(text) {
  return String(text ?? '').replace(/[\u2018-\u201f\u2032\u00b4`\u2010-\u2015\u2212\ufe58\ufe63\uff0d\u2026]/g, (character) => ASCII_PUNCTUATION[character] ?? character);
}

/**
 * Query variants to try, narrowest first, all lower-cased.
 *
 * AudiobookBay's search is **case-sensitive**, which is the least obvious thing about it. Measured
 * 2026-10-12: `?s=Baldur` answers its generic front page, while `?s=baldur` answers "Baldur's Gate 3:
 * Astarion - T. Kingfisher". Book metadata arrives capitalised, so every query is lower-cased before
 * it is sent; skipping that step makes almost every search look like an empty catalogue.
 *
 * The site also **ANDs** its search terms, so every extra word can empty the result set rather than
 * merely rank it lower. `Baldur` finds the book where `Baldur's Gate 3 T. Kingfisher` finds nothing,
 * so each variant is tried only while the previous one returned nothing.
 */
function queryCandidates(query, config, host, strategy) {
  const decorated = String(host.buildSearchText(query) ?? '').trim();
  const title = normalizeSearchPunctuation(query.title ?? '').trim();
  const author = normalizeSearchPunctuation(query.author ?? '').trim();
  // The words a title is worth searching by, most distinctive first.
  const words = meaningfulWords(title);
  const candidates = strategy === 'title-only'
    ? [title, words[0], words[1]]
    : [
      decorated,
      [title, author].filter(Boolean).join(' '),
      title,
      words[0],
      words[1],
    ];
  const seen = new Set();
  return candidates
    .map((value) => normalizeSearchPunctuation(value).replace(/\s+/g, ' ').trim())
    .filter((value) => {
      if (!value) return false;
      // Lower-cased here rather than at the request, so dedupe also collapses variants that differ
      // only in case.
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'with', 'book', 'vol', 'volume', 'part', 'novel', 'series']);

/**
 * Single words from a title that AudiobookBay is likely to answer, most distinctive first.
 *
 * Two things were measured against the live site on 2026-10-12 and both matter here:
 *
 *  - The site ANDs its terms, so a decorated title finds nothing where one word finds the book.
 *    `Baldur` finds "Baldur's Gate 3: Astarion - T. Kingfisher"; `Baldur's Gate 3 T. Kingfisher` does
 *    not.
 *  - A short word is answered where a long one is not, so ranking purely by length picks badly.
 *    `Baldur` is answered and `Baldur's` is not.
 *
 * Each word is therefore also offered with possessive and punctuation suffixes stripped, and the
 * plain form is preferred. The first word of the title is kept high in the order because the
 * catalogue's own titles start with it.
 */
function meaningfulWords(title) {
  const raw = normalizeSearchPunctuation(String(title ?? ''))
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, '').trim())
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word.toLowerCase()));

  const words = [];
  const push = (word) => {
    const value = String(word ?? '').trim();
    if (value.length <= 1) return;
    if (!words.some((existing) => existing.toLowerCase() === value.toLowerCase())) words.push(value);
  };
  // The plain form of each word first, so `Baldur` is reachable from `Baldur's`.
  for (const word of raw) push(word.replace(/['’]s?$/i, '').replace(/['’]/g, ''));
  // Then the title's own leading word, which is what the catalogue's titles begin with.
  if (raw[0]) push(raw[0]);
  return words;
}

/**
 * Builds a search URL.
 *
 * The query string is assembled by hand rather than with `URLSearchParams`, which would re-encode
 * the `+` that already stands for a space (`hail+mary` becomes `hail%2Bmary`) and make the site
 * search for a literal plus sign.
 */
function searchUrl(baseUrl, page, query, exactPhrase) {
  const path = page <= 1 ? '/' : `/page/${page}/`;
  // ABB expects its legacy category parameter alongside the term.
  return `${ensureBase(baseUrl)}${path}?s=${encodeQuery(query, exactPhrase)}&cat=${LEGACY_CATEGORY}`;
}

const LEGACY_CATEGORY = 'undefined%2Cundefined';

function encodeQuery(query, exactPhrase) {
  // Lower-cased, because AudiobookBay's search is case-sensitive: `?s=Baldur` answers its generic
  // front page while `?s=baldur` answers the book. Book metadata arrives capitalised.
  let value = String(query).trim().toLowerCase();
  if (exactPhrase && value && !(value.startsWith('"') && value.endsWith('"'))) value = `"${value}"`;
  // Space-as-'+' matches the site's own style; everything else is percent-encoded so a bare '&'
  // cannot open a new parameter and a stray '%' cannot start an invalid escape.
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function ensureBase(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  const url = new URL(raw || 'https://audiobookbay.lu');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid base URL');
  return url.origin;
}

/* ------------------------------------------------------------------ fetching */

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function request(config, host, pathOrUrl, { signal, method = 'GET', body, cookie, redirect = 'follow' } = {}) {
  const target = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : new URL(pathOrUrl, ensureBase(config.baseUrl)).href;
  // Paced here rather than at the call sites, so a session bootstrap, a candidate query and a retry
  // after a dropped answer all share one cadence instead of arriving back to back.
  try {
    const options = readOptions(config, host);
    if (options.pace) await pace(sessionKey(config), options.delayMs, signal);
  } catch (error) {
    if (error?.failure) throw error;
    throw host.fail('error', 'AudiobookBay search was cancelled');
  }
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' };
  if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  // The member area is session-bound, and host.fetch does not keep a cookie jar across calls.
  if (cookie) headers.Cookie = cookie;
  let response;
  try {
    response = await host.fetch(target, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect,
    });
  } catch (error) {
    if (error?.failure) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw host.fail('timeout', 'AudiobookBay request timed out');
    throw host.fail('unreachable', 'AudiobookBay could not be reached');
  }
  if (signal?.aborted) throw host.fail('error', 'AudiobookBay search was cancelled');
  if (response.status === 429) throw host.fail('throttled', 'AudiobookBay is rate limiting requests');
  if (response.status === 403) throw host.fail('unauthorized', 'AudiobookBay refused the request');
  // A manual-redirect caller reads the status itself, and a 302 is how AudiobookBay says "logged in",
  // so a 3xx is only an error when redirects were being followed.
  if (redirect !== 'manual' && !response.ok) throw host.fail('error', `AudiobookBay returned HTTP ${response.status}`);
  if (redirect === 'manual' && response.status >= 400) throw host.fail('error', `AudiobookBay returned HTTP ${response.status}`);
  return response;
}

/** The session cookie, if the response set one. host.fetch exposes no cookie jar. */
function sessionCookieOf(response) {
  const headers = response?.headers;
  const all = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers?.get?.('set-cookie')].filter(Boolean);
  for (const raw of all) {
    const match = /(?:^|,\s*)(PHPSESSID=[^;,\s]+)/i.exec(String(raw));
    if (match) return match[1];
  }
  return null;
}

/**
 * ABB answers reliable search pages only once its PHPSESSID is warm, so the homepage is fetched
 * first. Cached per base URL and dropped when a search redirects home, which is how the site says
 * "rejected" rather than "nothing matched".
 */
function sessionKey(config) {
  try { return ensureBase(config.baseUrl); } catch { return String(config.baseUrl ?? ''); }
}

/**
 * Warms a PHPSESSID before searching, which is what AudiobookBay's search pages expect.
 *
 * A failure here is **not** fatal, and treating it as fatal was a bug: measured 2026-10-12, the
 * homepage answered HTTP 500 while `/?s=...` answered normally with results, so a bootstrap that
 * threw turned a perfectly good search into zero results. The warm-up is best effort, and the search
 * response sets its own session cookie anyway.
 */
async function openSession(config, host, signal) {
  const key = sessionKey(config);
  const existing = sessions.get(key);
  if (existing) return existing;
  const pending = (async () => {
    try {
      await request(config, host, '/', { signal });
    } catch (error) {
      // A cancelled search is the caller's decision and must still propagate.
      if (error?.failure === 'unauthorized' || /cancelled|aborted/i.test(String(error?.message ?? ''))) throw error;
      host.logger.warn(`[audiobookbay.search] could not warm a session (${String(error?.message ?? error)}); searching anyway`);
    }
    return { at: Date.now() };
  })();
  sessions.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (sessions.get(key) === pending) sessions.delete(key);
    throw error;
  }
}

function invalidateSession(config) {
  sessions.delete(sessionKey(config));
}

/*
 * There deliberately is no "the final URL is the homepage, so the query was rejected" check here.
 *
 * One existed, ported from shelfmark, and it broke every search on BookOrbit: AudiobookBay answers a
 * search with HTTP 200 and the results in the body while sometimes reporting the bare homepage as
 * `response.url`, so the check discarded good pages and every query returned nothing. Measured
 * 2026-10-12: `/?s=hail+mary` and `/?s=tchaikovsky` both answered with the results, and the same site
 * answers a query it cannot match with a real "no results" page that keeps the query in its URL.
 * `response.url` therefore carries no signal at all.
 *
 * What distinguishes them is the content: a page that answered the query carries cards matching it,
 * and the homepage's "latest" feed does not. That is the relevance filter's job, below.
 */

function looksLikeAudiobookBay(html) {
  const text = String(html ?? '');
  return /audiobookbay/i.test(text) || /class=["']post["']/.test(text) || /postTitle/.test(text);
}

/* ------------------------------------------------------------ member access */

/**
 * Logs in and returns the session cookie.
 *
 * AudiobookBay's login is a plain `POST /member/login.php` with `username` and `password`. It carries
 * a one-time `_formkey_` that the form page embeds, whose cookie is still present on the page's own
 * response, so the key is taken from that header rather than from a second request.
 *
 * The password is what this plugin's credential field holds; the username is a setting, because
 * BookOrbit lends a plugin exactly one credential.
 *
 * A rejected login answers HTTP 200 with the login form and "Invalid login", while a successful one
 * redirects. Both are checked, because a wrong password would otherwise look like a success.
 */
const memberSessions = new Map();

function memberKey(config) {
  return `${config.id}:${sessionKey(config)}:${String(config.settings?.username ?? '').trim()}`;
}

async function openMemberSession(config, host, signal) {
  const username = String(config.settings?.username ?? '').trim();
  const password = String(config.credential ?? '');
  if (!username || !password) {
    throw host.fail('unauthorized', 'AudiobookBay needs its username setting and a stored password to download');
  }

  const loginPath = `${ensureBase(config.baseUrl)}/member/login.php`;
  const page = await request(config, host, loginPath, { signal, redirect: 'manual' });
  const cookie = sessionCookieOf(page);
  const html = await page.text();
  const formKey = matchFormKey(html);

  const body = new URLSearchParams();
  if (formKey) body.set('_formkey_', formKey);
  body.set('username', username);
  body.set('password', password);

  const attempt = await request(config, host, loginPath, {
    signal,
    method: 'POST',
    body: body.toString(),
    cookie,
    redirect: 'manual',
  });
  const attemptCookie = sessionCookieOf(attempt) ?? cookie;
  const status = attempt.status;
  const text = await attempt.text().catch(() => '');

  // A redirect away from the login form, or a page that is no longer the login form, is the success
  // signal. A 200 WITH the form back is a rejection, which is what a wrong password looks like: the
  // earlier version of this only special-cased the "Invalid login" sentence, so any other wording
  // would have let a rejected login through and only failed later, at the torrent link.
  const rejected = status >= 300 && status < 400
    ? false
    : /invalid login/i.test(text) || /name=["']password["']/i.test(text) || !text.trim();
  if (!rejected) return { cookie: attemptCookie ?? '' };
  if (/invalid login/i.test(text)) throw host.fail('unauthorized', 'AudiobookBay rejected the stored username and password');
  throw host.fail('unauthorized', 'AudiobookBay did not accept the login');
}

/**
 * The `_formkey_` hidden input, or null on a page that has none. Some mirrors dropped it, so a
 * missing key is tolerated rather than treated as an error.
 */
function matchFormKey(html) {
  const match = /name=["']_formkey_["'][^>]*value=["']([^"']*)["']/i.exec(String(html ?? ''))
    ?? /value=["']([^"']*)["'][^>]*name=["']_formkey_["']/i.exec(String(html ?? ''));
  return match?.[1] ?? null;
}

async function memberCookie(config, host, signal) {
  const key = memberKey(config);
  const cached = memberSessions.get(key);
  if (cached) return cached.cookie;
  const session = await openMemberSession(config, host, signal);
  memberSessions.set(key, session);
  return session.cookie;
}

function forgetMemberSession(config) {
  memberSessions.delete(memberKey(config));
}

/**
 * Fetches the picked release's `.torrent` file with the member session.
 *
 * Measured 2026-10-12 against a real account: `/downld0?downfs=...` answers
 * `application/x-bittorrent`, 61,202 bytes, first byte `0x64`, with
 * `content-disposition: attachment; filename="<id>.torrent"`. For a guest the same URL answers 88
 * bytes of HTML pointing at the login page, so both the status and the body are checked rather than
 * assumed.
 *
 * Never synthesises a `.torrent`: a torrent is identified by its piece hashes, which the site does
 * not publish outside this file.
 */
async function fetchMemberTorrent(release, config, host) {
  if (!config.credential) {
    throw host.fail('unauthorized', 'AudiobookBay needs a stored account password to download; add one to this source, or the release cannot be fetched');
  }
  const detail = await memberDetail(release, config, host);
  const downloadUrl = downloadUrlFromHtml(detail.html, config);
  if (!downloadUrl) {
    throw host.fail('error', 'AudiobookBay published no torrent download link for this release');
  }

  let cookie = await memberCookie(config, host, undefined);
  let body = await getTorrentBytes(config, host, downloadUrl, cookie);
  if (body === null) {
    // The session lapsed between one grab and the next. One re-login, then the same URL again.
    forgetMemberSession(config);
    cookie = await memberCookie(config, host, undefined);
    body = await getTorrentBytes(config, host, downloadUrl, cookie);
  }
  if (body === null) {
    throw host.fail('unauthorized', 'AudiobookBay answered the torrent link with a page instead of a .torrent file, so the session is not valid');
  }
  if (body.byteLength === 0) throw host.fail('error', 'AudiobookBay returned an empty .torrent file');
  if (body.byteLength > MAX_TORRENT_BYTES) throw host.fail('error', 'AudiobookBay returned a .torrent file that is too large');
  host.logger.log(`[audiobookbay.resolve] fetched a .torrent (${body.byteLength} bytes)`);
  return body;
}

/** The member detail page, which is where the torrent link for this session lives. */
async function memberDetail(release, config, host) {
  const url = detailUrlOf(release, config, host);
  const cookie = await memberCookie(config, host, undefined);
  let response = await request(config, host, url, { cookie, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    forgetMemberSession(config);
    response = await request(config, host, url, { cookie: await memberCookie(config, host, undefined), redirect: 'manual' });
  }
  return { html: await response.text() };
}

/**
 * The Torrent Download link, matched on its own path so the three monetisation links
 * (`/dodl3-no`, `/dedl4-now`, `/hi-3dl`) that redirect to third-party hosts are never chosen.
 */
function downloadUrlFromHtml(html, config) {
  const match = /href=["'](\/downld0\?[^"']*)["']/i.exec(String(html ?? ''));
  if (!match) return null;
  try {
    const url = new URL(match[1].replace(/&amp;/g, '&'), ensureBase(config.baseUrl));
    if (url.hostname !== new URL(ensureBase(config.baseUrl)).hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The bytes, or null when the response is a page rather than a torrent. */
async function getTorrentBytes(config, host, url, cookie) {
  const response = await request(config, host, url, { cookie, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) return bytes; // left for the caller's empty check, not read as a page
  // bencode starts its dictionary with 'd'. A login page starts with '<'.
  return bytes[0] === 0x64 ? bytes : null;
}

/** A torrent file is small; this only exists so a wrong URL cannot land megabytes in memory. */
const MAX_TORRENT_BYTES = 10 * 1024 * 1024;

/* -------------------------------------------------------------------- search */

async function searchAllPages(candidate, wanted, config, host, options, session) {
  const collected = [];
  for (let page = 1; page <= options.maxPages; page += 1) {
    if (options.signal?.aborted) break;
    if (page > 1) await sleep(options.delayMs);
    const releases = await searchPage(candidate, page, config, host, options, session);
    collected.push(...releases);
    if (releases.length === 0 || collected.length >= wanted) break;
  }
  return dedupeReleases(collected).slice(0, wanted);
}

/**
 * Whether AudiobookBay actually answered this query, rather than quietly serving its front page.
 *
 * Under load the site drops a search and returns its generic "latest" feed with HTTP 200, the query
 * URL intact and nine result cards present, so neither the status, the URL nor the card count tells
 * the two apart. The page title does: an answered query is titled "<Query> Audiobook" (and
 * "<Query> Audiobook, Page N" when paged), while the feed is titled "Unabridged Audiobooks Free
 * Online". Measured 2026-10-12: `?s=tchaikovsky` answered "Tchaikovsky Audiobook" with nine
 * Tchaikovsky releases, `?s=zzzzqqqqnotarealbook` answered "Zzzzqqqqnotarealbook Audiobook" with no
 * cards, and a throttled `?s=The+Hobbit` answered the feed.
 *
 * This matters because the feed shares words with real queries: a search for "Dogs of War" otherwise
 * matches the feed's "The Bear and the Serpent" on the word "war" and returns the wrong book.
 */
function isQueryAnswer(html, candidate) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? '')) ?? [])[1] ?? '';
  const normalised = decodeEntities(title).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalised) return false;
  const firstWord = normalizeSearchPunctuation(String(candidate ?? ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)[0] ?? '';
  if (!firstWord) return true;
  return normalised.includes(firstWord);
}

/**
 * Fetches a search page, retrying a server error once.
 *
 * AudiobookBay answers transient 500s under load, and measured 2026-10-12 it answered one for a search
 * that succeeded moments later. A 5xx is therefore retried like a dropped answer rather than thrown,
 * because throwing it fails the whole search over something that resolves itself.
 */
async function fetchSearchPage(config, host, url, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await request(config, host, url, { signal: options.signal });
      return { response, html: await response.text() };
    } catch (error) {
      const status = /HTTP 5\d\d/.test(String(error?.message ?? ''));
      // Retried only on the first candidate: a server error on a fallback the search does not need is
      // not worth spending the caller's deadline on.
      if (!status || !options.retryServerErrors || attempt >= SEARCH_PAGE_ATTEMPTS || options.signal?.aborted) throw error;
      host.logger.warn(`[audiobookbay.search] AudiobookBay returned a server error (${String(error?.message ?? error)}); retrying`);
      await sleep(THROTTLE_RETRY_DELAY_MS);
    }
  }
}

async function searchPage(candidate, page, config, host, options, session) {
  const url = searchUrl(config.baseUrl, page, candidate, options.exactPhrase);
  const fetched = await fetchSearchPage(config, host, url, options);
  let response = fetched.response;
  let html = fetched.html;

  /*
   * There deliberately is no "the final URL is the homepage, so the query was rejected" check: one
   * existed, ported from shelfmark, and it broke every search on BookOrbit, because AudiobookBay
   * reports the bare homepage as `response.url` while returning the results in the body.
   * `response.url` carries no signal here.
   */
  if (page === 1 && !html.trim()) {
    for (let attempt = 1; attempt <= SEARCH_PAGE_ATTEMPTS; attempt += 1) {
      invalidateSession(config);
      session = await openSession(config, host, options.signal);
      const retried = await fetchSearchPage(config, host, url, options);
      response = retried.response;
      html = retried.html;
      if (html.trim()) break;
    }
    if (!html.trim()) {
      host.logger.warn('[audiobookbay.search] AudiobookBay answered the search with an empty body');
      return [];
    }
  }

  // The site served its front page instead of an answer, which is how it drops a search when it is
  // rate limiting. It recovers on its own within seconds, so one spaced retry is worth it; a feed
  // reported as results would instead return whichever latest releases share a word with the query.
  if (!isQueryAnswer(html, candidate) && page === 1) {
    for (let attempt = 1; attempt <= THROTTLE_RETRY_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) break;
      await sleep(THROTTLE_RETRY_DELAY_MS);
      response = await request(config, host, url, { signal: options.signal });
      html = await response.text();
      if (isQueryAnswer(html, candidate)) break;
    }
  }
  if (!isQueryAnswer(html, candidate)) {
    host.logger.warn('[audiobookbay.search] AudiobookBay answered with its front page instead of search results, which means it is rate limiting; try a lower search frequency');
    return [];
  }

  const parsed = parseSearchResults(html, config.baseUrl);
  const queryWords = relevanceWords(candidate);
  // The format filter is applied here rather than after pagination, so a page of unsupported
  // formats still lets the walk continue to a page that has one.
  return parsed
    .filter((item) => item.format !== null && options.formats.includes(item.format) && relevant(item, queryWords))
    .map((item) => ({
    guid: item.url,
    title: item.title,
    ...(item.bookTitle ? { bookTitle: item.bookTitle } : {}),
    downloadUrl: item.url,
    ...(item.author ? { author: item.author } : {}),
    ...(item.format ? { format: item.format } : {}),
    ...(item.language ? { language: item.language } : {}),
    sizeBytes: item.sizeBytes,
    // ABB states no swarm counts on a search page. Null, never 0: a zero would be read as a real
    // count and the zero-seeder filter would drop every AudiobookBay release.
    seeders: null,
    leechers: null,
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.bitrateKbps !== null ? { audio: { bitrateKbps: item.bitrateKbps, bitrateMode: null, channels: null, samplingRateHz: null, durationSeconds: null, chapterCount: null } } : {}),
    primaryFileCount: 1,
  }));
}

function dedupeReleases(releases) {
  const seen = new Set();
  const output = [];
  for (const release of releases) {
    if (seen.has(release.guid)) continue;
    seen.add(release.guid);
    output.push(release);
  }
  return output;
}

const MIN_RELEVANCE_WORD_LENGTH = 2;

function relevanceWords(query) {
  return new Set(
    normalizeSearchPunctuation(query)
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter((word) => word.length > MIN_RELEVANCE_WORD_LENGTH),
  );
}

/**
 * AudiobookBay leaks its "latest" feed into some searches, so a result is kept only when it shares
 * a meaningful word with the query. Without this a title-only fallback can return the whole front
 * page.
 */
function relevant(item, queryWords) {
  if (queryWords.size === 0) return true;
  const haystack = normalizeSearchPunctuation(`${item.title} ${item.bookTitle ?? ''}`).toLowerCase();
  for (const word of queryWords) if (haystack.includes(word)) return true;
  return false;
}

/* -------------------------------------------------------------------- resolve */

async function resolveMagnet(release, config, host, signal) {
  const detailUrl = detailUrlOf(release, config, host);
  const response = await request(config, host, detailUrl, { signal });
  const html = await response.text();
  const hash = infoHashFromHtml(html);
  if (!hash) throw host.fail('error', 'AudiobookBay detail page stated no usable info hash');
  const trackers = trackersFromHtml(html);
  return buildMagnet(hash, trackers.length > 0 ? trackers : DEFAULT_TRACKERS);
}

/**
 * The release guid is the detail page URL, which is both stable and unique. It is validated against
 * the configured base host so a release cannot steer a grab at another site.
 */
function detailUrlOf(release, config, host) {
  const raw = String(release?.downloadUrl ?? release?.guid ?? '').trim();
  if (!raw) throw host.fail('error', 'release is missing an AudiobookBay detail URL');
  let url;
  try { url = new URL(raw); } catch { throw host.fail('error', 'release has an invalid AudiobookBay detail URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw host.fail('error', 'release has an invalid AudiobookBay detail URL');
  let expected;
  try { expected = new URL(ensureBase(config.baseUrl)); } catch { throw host.fail('error', 'AudiobookBay base URL is invalid'); }
  if (url.hostname.replace(/^www\./i, '').toLowerCase() !== expected.hostname.replace(/^www\./i, '').toLowerCase()) {
    throw host.fail('error', 'release detail URL does not belong to the configured AudiobookBay host');
  }
  return url.href;
}

export function buildMagnet(hash, trackers) {
  const clean = String(hash ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(clean) && !/^[0-9A-F]{64}$/.test(clean)) throw new Error('invalid info hash');
  const parts = [`magnet:?xt=urn:btih:${clean}`];
  for (const tracker of trackers ?? []) {
    const value = String(tracker ?? '').trim();
    if (value) parts.push(`tr=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}

/* --------------------------------------------------------------------- parse */

function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Strips tags to text, turning block boundaries into spaces so labels do not run together. */
function textOf(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function attributeOf(tag, name) {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(String(tag ?? ''));
  if (!match) return '';
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

/**
 * First element whose tag matches, using its attributes and inner markup.
 *
 * The scan walks forward with an anchored slice rather than regex `lastIndex`: the pattern is not
 * global, so keeping `lastIndex` across attempts would silently resume at a stale offset and skip
 * the element being looked for.
 */
function findElement(html, tag, attributes = []) {
  const source = String(html ?? '');
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'i');
  let offset = 0;
  while (offset < source.length) {
    const slice = source.slice(offset);
    const match = pattern.exec(slice);
    if (!match) return null;
    const attrs = match[1] ?? '';
    const ok = attributes.every((entry) => {
      if (entry.class) return classMatches(attributeOf(`<x ${attrs}>`, 'class'), entry.class);
      return new RegExp(`${entry.name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').test(attrs);
    });
    if (ok) return { attrs, html: match[2] ?? '', text: textOf(match[2] ?? '') };
    offset += match.index + 1;
  }
  return null;
}

function classMatches(value, wanted) {
  return String(value ?? '').split(/\s+/).includes(wanted);
}

function findAllElements(html, tag, className) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const output = [];
  let match;
  while ((match = pattern.exec(String(html ?? ''))) !== null) {
    const attrs = match[1] ?? '';
    if (className && !classMatches(attributeOf(`<x ${attrs}>`, 'class'), className)) continue;
    output.push({ attrs, html: match[2] ?? '', text: textOf(match[2] ?? '') });
  }
  return output;
}

/**
 * Positions of every opening tag carrying a class, in document order. A block runs from just inside
 * its opening tag to just inside the next sibling block of the same class, which audio sites render
 * as flat siblings (one `<div class="post">` per result). Looking at the next block rather than the
 * next tag matters: the first child tag is immediately adjacent, so a next-tag boundary is empty.
 */
function streamByClass(html, className) {
  const pattern = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  const source = String(html ?? '');
  const output = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const attrs = match[2] ?? '';
    if (!classMatches(attributeOf(`<x ${attrs}>`, 'class'), className)) continue;
    output.push({ tag: match[1].toLowerCase(), start: match.index, end: match.index + match[0].length });
  }
  for (let index = 0; index < output.length; index += 1) {
    output[index].blockEnd = index + 1 < output.length ? output[index + 1].start : source.length;
  }
  return output;
}

function blockOf(entry, source) {
  return source.slice(entry.end, entry.blockEnd);
}

/**
 * Inner markup of the first element with the given tag and class, found by tracking nesting depth.
 *
 * A non-greedy `<div>...</div>` match stops at the first inner `</div>`, which truncates any block
 * that contains nested divs. The card's content div wraps a `<div class="center">`, so that mistake
 * silently drops the format, bitrate and file size.
 */
function innerOfClass(html, tag, className) {
  const source = String(html ?? '');
  const open = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  let match;
  while ((match = open.exec(source)) !== null) {
    if (!classMatches(attributeOf(`<x ${match[1] ?? ''}>`, 'class'), className)) continue;
    const innerStart = match.index + match[0].length;
    const tagPattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagPattern.lastIndex = innerStart;
    let depth = 1;
    let tagMatch;
    while ((tagMatch = tagPattern.exec(source)) !== null) {
      depth += tagMatch[1] === '/' ? -1 : 1;
      if (depth === 0) return source.slice(innerStart, tagMatch.index);
    }
    return source.slice(innerStart);
  }
  return '';
}

/**
 * AudiobookBay renders each result as `<div class="post">`. The title links to the detail page,
 * `.postInfo` carries the language, and `.postContent` carries the posted date, format, bitrate and
 * file size as labelled text.
 */
export function parseSearchResults(html, baseUrl) {
  const source = String(html ?? '');
  let base = '';
  try { base = ensureBase(baseUrl); } catch { base = ''; }
  const posts = streamByClass(source, 'post');
  const results = [];
  for (const post of posts) {
    const block = blockOf(post, source);
    const titleLink = findElement(findElement(block, 'div', [{ class: 'postTitle' }])?.html ?? '', 'a');
    if (!titleLink) continue;
    const title = normalizeSearchPunctuation(titleLink.text);
    if (!title) continue;
    const href = attributeOf(titleLink.attrs, 'href');
    const url = absoluteUrl(href, source, base);
    if (!url) continue;

    const infoHtml = innerOfClass(block, 'div', 'postInfo');
    const contentHtml = innerOfClass(block, 'div', 'postContent');
    // ABB wraps some values in styled <span>s (`File Size: <span>205.01</span> MBs`), so the card is
    // flattened to text before labels are read. Matching on raw markup would miss the value.
    const contentText = textOf(contentHtml);
    const infoText = textOf(infoHtml);

    // postContent holds the cover image; postInfo is only a fallback.
    const cover = coverFrom(contentHtml || infoHtml, source, base);
    const { title: bookTitle, author } = splitTitleAndAuthor(title);
    const format = matchLabel(contentText, 'Format');
    const sizeText = matchLabel(contentText, 'File Size', '([\\d.,]+\\s*[A-Za-z]+)');
    const posted = matchLabel(contentText, 'Posted', '([0-9]{1,2}\\s+[A-Za-z]{3,}\\s+[0-9]{4})');
    // A single word only: the flattened info text runs straight on into "Keywords:".
    const languageRaw = matchLabel(infoText, 'Language');

    results.push({
      url,
      title,
      ...(bookTitle && bookTitle !== title ? { bookTitle } : {}),
      ...(author ? { author } : {}),
      format: format ? format.toLowerCase() : null,
      sizeBytes: parseSize(sizeText),
      language: mapLanguage(languageRaw),
      // The value carries a unit, so it cannot use the single-token default pattern.
      bitrateKbps: parseBitrate(matchLabel(contentText, 'Bitrate', '([\\d.]+\\s*kbps)')),
      publishedAt: posted ? toIsoDate(posted) : null,
      cover,
    });
  }
  return results;
}

const NBSP = /\u00a0/g;

/**
 * Reads `Label: value` out of a flattened card. The value stops at the next space, which is enough
 * for every field ABB states on a card (`M4B`, `256 Kbps`, `11.68 GBs`).
 */
function matchLabel(text, label, valuePattern = '([^\\s<]+)') {
  const pattern = new RegExp(`${label}\\s*:?\\s*${valuePattern}`, 'i');
  const match = pattern.exec(String(text ?? ''));
  if (!match) return null;
  const value = String(match[1] ?? '').trim();
  return value || null;
}

function coverFrom(html, pageHtml, base) {
  // `img` is a void element, so it can never be matched by a `<img>...</img>` pattern.
  for (const match of String(html ?? '').matchAll(/<img\b([^>]*)>/gi)) {
    const src = attributeOf(`<x ${match[1] ?? ''}>`, 'src');
    if (src) return absoluteUrl(src, pageHtml, base);
  }
  return null;
}

/** Resolves a scraped link against, in order: the page's own <base>, then the configured site. */
function absoluteUrl(raw, pageHtml, base) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  const baseMatch = /<base\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(String(pageHtml ?? ''));
  if (baseMatch) {
    try { return new URL(value, baseMatch[2] ?? baseMatch[3]).href; } catch { /* fall through */ }
  }
  if (base) {
    try { return new URL(value, base).href; } catch { /* fall through */ }
  }
  return value.startsWith('/') ? value : null;
}

/**
 * Cards are titled `Title - Author`, which is the only place AudiobookBay states the author. The
 * split is on the last separator so a title containing one survives.
 */
export function splitTitleAndAuthor(rawTitle) {
  const cleaned = String(rawTitle ?? '').trim();
  if (!cleaned || !cleaned.includes(' - ')) return { title: cleaned, author: null };
  const cut = cleaned.lastIndexOf(' - ');
  const title = cleaned.slice(0, cut).trim();
  const author = cleaned.slice(cut + 3).trim();
  if (!title || !author) return { title: cleaned, author: null };
  return { title, author };
}

const LANGUAGE_CODES = {
  english: 'en', german: 'de', french: 'fr', spanish: 'es', italian: 'it', portuguese: 'pt',
  dutch: 'nl', russian: 'ru', polish: 'pl', swedish: 'sv', danish: 'da', norwegian: 'no',
  finnish: 'fi', czech: 'cs', hungarian: 'hu', turkish: 'tr', japanese: 'ja', chinese: 'zh',
  korean: 'ko', greek: 'el', hebrew: 'he', arabic: 'ar', hindi: 'hi', ukrainian: 'uk',
};

function mapLanguage(raw) {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (!value) return null;
  return LANGUAGE_CODES[value] ?? value;
}

function parseBitrate(raw) {
  const match = /(\d+(?:\.\d+)?)\s*kbps/i.exec(String(raw ?? ''));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function parseSize(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  const match = /([\d.,]+)\s*([KMGT]?)(?:i?B)S?/i.exec(String(raw).trim());
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value < 0) return null;
  const multipliers = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const multiplier = multipliers[(match[2] ?? '').toUpperCase()];
  if (multiplier === undefined) return null;
  return Math.round(value * multiplier);
}

function toIsoDate(raw) {
  const match = /([0-9]{1,2})\s+([A-Za-z]{3,})\s+([0-9]{4})/.exec(String(raw ?? ''));
  if (!match) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.findIndex((name) => match[2].toLowerCase().startsWith(name));
  if (month < 0) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const iso = new Date(Date.UTC(year, month, day));
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** Table rows as label/value pairs, which is how the detail page states everything it knows. */
export function detailRows(html) {
  const rows = [];
  for (const row of findAllElements(String(html ?? ''), 'tr')) {
    const cells = findAllElementsDeep(row.html, 'td');
    if (cells.length === 0) continue;
    const label = cells[0].text;
    rows.push({
      label,
      value: cells.length > 1 ? cells[1].text : '',
      colspan: attributeOf(`<x ${cells[0].attrs}>`, 'colspan'),
      single: cells.length === 1,
    });
  }
  return rows;
}

/** `td` elements inside a row, without letting a nested table swallow the outer cells. */
function findAllElementsDeep(html, tag) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const output = [];
  let match;
  while ((match = pattern.exec(String(html ?? ''))) !== null) {
    output.push({ attrs: match[1] ?? '', html: match[2] ?? '', text: textOf(match[2] ?? '') });
  }
  return output;
}

/**
 * The info hash is stated in its own row. It arrives lower-cased and sometimes split across lines,
 * so whitespace is removed and the result upper-cased before validation.
 */
export function infoHashFromHtml(html) {
  const source = String(html ?? '');
  for (const row of detailRows(source)) {
    const hash = normalizeHash(row.value);
    if (hash) return hash;
    if (!/^info\s*hash$/i.test(row.label.replace(/\s+/g, ' ').trim())) continue;
    const next = normalizeHash(row.value) ?? normalizeHash(row.label);
    if (next) return next;
  }
  // Fallback: a magnet posted on the page (for example in a comment) still identifies the torrent.
  const magnet = /magnet:\?[^\s"'<>]*xt=urn:btih:([0-9a-zA-Z]{40,64})/i.exec(source);
  if (magnet) return normalizeHash(magnet[1]);
  return null;
}

function normalizeHash(value) {
  const clean = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  if (/^[0-9A-F]{40}$/.test(clean) || /^[0-9A-F]{64}$/.test(clean)) return clean;
  return null;
}

export function trackersFromHtml(html) {
  const found = new Set();
  for (const row of detailRows(String(html ?? ''))) {
    const candidates = row.single ? [row.label] : [row.value, row.label];
    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (/^(udp|https?|wss?):\/\//i.test(value) && !/\s/.test(value)) found.add(value);
    }
  }
  return [...found];
}

/**
 * The file table sits between the "This is a Multifile Torrent" marker (absent on single-file
 * torrents) and the "Combined File Size" row.
 */
export function fileListFromHtml(html) {
  const rows = detailRows(String(html ?? ''));
  let inFiles = false;
  const files = [];
  for (const row of rows) {
    if (/^combined\s+file\s+size/i.test(row.label)) return files.length > 0 ? files : null;
    if (!row.single) { inFiles = false; files.length = 0; continue; }
    if (/multifile\s+torrent/i.test(row.label)) { inFiles = true; files.length = 0; continue; }
    const parsed = parseFileRow(row.label);
    if (parsed) { files.push(parsed); inFiles = true; }
  }
  return null;
}

function parseFileRow(text) {
  const match = /^(.*?)\s+([\d.]+)\s*(Bytes?|KBs?|MBs?|GBs?|TBs?)$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  const sizeBytes = parseSize(`${match[2]} ${match[3]}`);
  if (sizeBytes === null) return null;
  const name = match[1].trim();
  if (!name) return null;
  return { name, sizeBytes };
}
