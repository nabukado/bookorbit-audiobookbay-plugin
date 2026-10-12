/**
 * Credential-safe probe for AudiobookBay's member download endpoints.
 *
 * Answers one question: with a logged-in member session, does any of ABB's download endpoints return
 * real `.torrent` bytes (bencode, first byte 0x64), a file, or still an HTML gate?
 *
 * Credentials are read from the environment and are never printed, never written to disk, never put
 * in a URL, and never included in the report. Only status codes, content types, byte counts, the
 * first byte, redirect destinations and whether a body is bencode are reported.
 *
 *   BOOKORBIT_ABB_USER='you' BOOKORBIT_ABB_PASS='secret' \
 *     node probe-member-download.mjs [--detail-url https://audiobookbay.lu/abss/<slug>/]
 *
 * With no --detail-url it searches for BOOKORBIT_ABB_QUERY (default "project hail mary") and probes
 * the first result. No file content is ever downloaded: every fetch is capped.
 */
const BASE = (process.env.BOOKORBIT_ABB_BASE_URL ?? 'https://audiobookbay.lu').replace(/\/+$/, '');
const USER = process.env.BOOKORBIT_ABB_USER ?? '';
const PASS = process.env.BOOKORBIT_ABB_PASS ?? '';
const QUERY = process.env.BOOKORBIT_ABB_QUERY ?? 'project hail mary';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MAX_PROBE_BYTES = 400_000;

const jar = new Map();

function cookieHeader() {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function absorbCookies(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function get(url, init = {}) {
  const response = await fetch(url, {
    redirect: init.redirect ?? 'follow',
    method: init.method ?? 'GET',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body ? { body: init.body } : {}),
  });
  absorbCookies(response);
  return response;
}

/** Reads at most MAX_PROBE_BYTES so a probe can never pull a whole audiobook. */
async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.slice(0, MAX_PROBE_BYTES);
  }
  const chunks = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_PROBE_BYTES - total;
    if (value.byteLength >= remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      capped = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel?.().catch(() => {});
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  out.capped = capped;
  return out;
}

function describeBytes(bytes) {
  const first = bytes.byteLength > 0 ? bytes[0] : null;
  return {
    bytes: bytes.byteLength,
    firstByteHex: first === null ? null : `0x${first.toString(16).padStart(2, '0')}`,
    isBencodeTorrent: first === 0x64,
    isHtml: first === 0x3c,
    capped: Boolean(bytes.capped),
  };
}

if (!USER || !PASS) {
  console.error('Set BOOKORBIT_ABB_USER and BOOKORBIT_ABB_PASS (credentials are never printed).');
  process.exit(2);
}

console.log(`probe: base=${BASE} user=<redacted, ${USER.length} chars> query=${JSON.stringify(QUERY)}`);

// --- 1. log in
const loginPage = await get(`${BASE}/member/login.php`);
await readCapped(loginPage);
const loginResponse = await get(`${BASE}/member/login.php`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: USER, password: PASS }).toString(),
});
console.log(`login: HTTP ${loginResponse.status}${loginResponse.headers.get('location') ? ` location=${String(loginResponse.headers.get('location')).replace(/\?.*$/, '')}` : ''}`);

// A rejected login answers 200 with the form and "Invalid login, please try again"; a successful one
// redirects away. An earlier version of this probe checked an authenticated-only page for the absence
// of a password field, which reported success for a page that is a 404 to everybody. The login POST
// response itself is the only reliable signal, so it is checked directly.
const body = await loginResponse.text();
const loginFormPresent = /name=["']password["']/i.test(body);
const invalidLogin = /invalid login/i.test(body);
const loggedIn = loginResponse.status >= 300 && loginResponse.status < 400 ? true : !loginFormPresent && !invalidLogin;
console.log(`session: loginStatus=${loginResponse.status} cookieNames=${[...jar.keys()].join(',') || 'none'} loginFormPresent=${loginFormPresent} invalidLogin=${invalidLogin} appearsLoggedIn=${loggedIn}`);
if (!loggedIn) {
  console.log('!! AudiobookBay REJECTED the credentials ("Invalid login"). Everything below is the guest view.');
  console.log('!! The endpoint signatures below therefore prove nothing about member access.');
}

// --- 2. pick a release
let detailUrl = null;
const flag = process.argv.indexOf('--detail-url');
if (flag >= 0) {
  detailUrl = process.argv[flag + 1] ?? null;
} else {
  const search = await get(`${BASE}/?s=${encodeURIComponent(QUERY).replace(/%20/g, '+')}&cat=undefined%2Cundefined`);
  const searchHtml = new TextDecoder().decode(await readCapped(search));
  const match = /<div class="postTitle"><h2><a href="([^"]+)"/i.exec(searchHtml);
  if (match) detailUrl = match[1].startsWith('http') ? match[1] : `${BASE}${match[1]}`;
}
if (!detailUrl) {
  console.error('probe: could not find a detail URL to probe');
  process.exit(1);
}
console.log(`detail: ${detailUrl.replace(BASE, '')}`);

const detail = await get(detailUrl);
const detailHtml = new TextDecoder().decode(await readCapped(detail));

// --- 3. enumerate every download affordance on the detail page
const endpoints = [];
for (const m of detailHtml.matchAll(/<a\b[^>]*href=["'](\/(?:downld0|dedl4-now|dodl3-no|hi-3dl|dl2|dl4|dload|get)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
  const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '(icon link)';
  endpoints.push({ label, path: m[1], href: `${BASE}${m[1]}` });
}
console.log(`download affordances found: ${endpoints.length}`);
for (const e of endpoints) console.log(`  ${e.label} -> ${e.path.replace(/\?.*$/, '?…')}`);

// --- 4. probe each one, following redirects, reporting only the signature
console.log('\nendpoint signatures (no content is kept):');
for (const endpoint of endpoints) {
  const response = await get(endpoint.href, { redirect: 'follow' });
  const bytes = await readCapped(response);
  const info = describeBytes(bytes);
  const finalUrl = String(response.url).replace(BASE, '');
  const disposition = response.headers.get('content-disposition') ?? '';
  console.log(`  ${endpoint.path.replace(/\?.*$/, '?…')}`);
  console.log(`    status=${response.status} type=${response.headers.get('content-type')} ${JSON.stringify(info)}`);
  console.log(`    final=${finalUrl.slice(0, 120)}${disposition ? ` disposition=${disposition}` : ''}`);
}

console.log('\nprobe complete. No file content was retained, and no credential was printed.');
