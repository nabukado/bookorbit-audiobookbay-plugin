# Architecture

AudiobookBay indexer plugin for BookOrbit, plugin API v1.

This document records the design and the measured facts about AudiobookBay that the implementation
depends on. Those facts are the durable part: the site's behaviour is quirky in ways that are not
guessable from its markup, and each one below was measured rather than assumed. When the plugin breaks,
start here.

- Plugin runtime: [`indexers/audiobookbay/index.mjs`](indexers/audiobookbay/index.mjs)
- Tests: [`verify.mjs`](verify.mjs) (88 offline checks), [`scripts/probe-member-download.mjs`](scripts/probe-member-download.mjs)
- Fixtures and their provenance: [`fixtures/README.md`](fixtures/README.md)

Compatibility and status: [README.md](README.md).

---

## 1. Contract mapping

| BookOrbit field | Value |
| --- | --- |
| `apiVersion` | `1` |
| `type` | `audiobookbay` |
| `mediaKinds` | `['audiobook']` |
| `requiresCredential` | `true` — AudiobookBay serves `.torrent` files only to a logged-in account |
| `credentialKind` | `apiKey` — the credential field holds the account **password** |
| `usesCategories` | `false` |
| `seedsBack` | `true` — a grab joins a swarm |
| `defaultBaseUrl` | `https://audiobookbay.lu` (editable, for mirror rotation) |
| grab function | `fetchTorrentFile`, returning real `.torrent` bytes |
| `resolveFile` | not declared — direct download is a separate BookOrbit feature and AudiobookBay has no file URL to give (section 3) |

BookOrbit lends a plugin exactly **one** credential, so the password lives there and the username is a
plugin setting (`username`).

---

## 2. Measured facts about AudiobookBay

Each of these was measured against the live site on 2026-10-12. The first three are the ones that caused
a working-looking plugin to return nothing.

### 2.1 Search is case-sensitive

| Query | Answer |
| --- | --- |
| `?s=Baldur` | its generic front page |
| `?s=baldur` | "Baldur Audiobook", first card `Baldur's Gate 3: Astarion - T. Kingfisher` |

Book metadata arrives capitalised, so **every query must be lower-cased before it is sent**. Skipping
that step makes almost every search look like an empty catalogue.

### 2.2 Search ANDs its terms, so shorter queries work better

`Baldur` finds the book; `Baldur's Gate 3 T. Kingfisher` finds nothing. Every extra word can empty the
result set rather than merely rank it lower. Query variants are therefore tried narrowest first, each
only while the previous returned nothing:

1. `buildSearchText(query)` — title plus author, as BookOrbit composes it
2. title plus author
3. title alone
4. the most distinctive single word from the title (possessive stripped: `Baldur's` → `Baldur`)
5. the next word

A short word is answered where a long one is not, which is why the plain form is preferred over the
title's own longest word.

### 2.3 A dropped search returns the front page, not an error

When AudiobookBay drops a search — under load, or because nothing matched — it answers **HTTP 200 with
its generic "latest" feed**, the query still in the URL, and nine result cards present. Status, URL and
card count are all indistinguishable from a real answer.

The page `<title>` is the only reliable signal:

| Response | `<title>` |
| --- | --- |
| answered query | `<Query> Audiobook` (or `<Query> Audiobook, Page N`) |
| no matches | `<Query> Audiobook` with no cards |
| dropped / throttled | `Unabridged Audiobooks Free Online` |

`response.url` carries **no** signal: the site frequently reports the bare homepage as the final URL
while returning the results in the body. An earlier revision treated "final URL is the homepage" as a
rejection and discarded every successful search.

This check also prevents returning the wrong book. The front page carries titles like *The Bear and the
Serpent*, so a search for "Dogs of War" would otherwise match it on the word "war".

### 2.4 The site rate-limits on bursts

Single requests a few seconds apart are answered indefinitely; requests arriving back to back make the
site answer its front page instead of results. Every request is therefore paced from one place, with a
1-second default pause between them (configurable, minimum enforced). A low setting does not make
searches faster, it makes them come back empty.

### 2.5 Transient failures are normal

- The homepage answered **HTTP 500** while `/?s=...` answered normally. The session warm-up is
  best-effort for that reason; treating it as fatal aborted searches that would have succeeded.
- Searches themselves answer **500** under load and recover within seconds, so a first-candidate 5xx is
  retried once.

AudiobookBay throttling and erroring is normal operation, not an exception. The plugin reports the
distinction in its log rather than returning a bare zero.

### 2.6 Session handling

A `PHPSESSID` is warmed with a homepage GET before searching. `host.fetch` keeps no cookie jar across
calls, so cookies are carried explicitly by the plugin.

---

## 3. How a grab works

AudiobookBay's detail page exposes five download links. Only one is real:

| Link label | Path | Behaviour |
| --- | --- | --- |
| **Torrent Download** | `/downld0?downfs=...` | **Member session:** `200 application/x-bittorrent`, bencode, `content-disposition: attachment; filename="<id>.torrent"`. **Guest:** 88 bytes of HTML pointing at the login form. |
| Torrent Download (icon) | `/dodl3-no?dow=...` | 302 to `cyberpour.com`, a paid signup service |
| Start Direct Download | `/dedl4-now?teb=...` | 302 to `cyberpour.com` |
| Download Files Now | `/hi-3dl?downf=...` | 302 to `cyberpour.com` |
| (icons) | `/ddeaatr`, `/dl-14-days-trial` | 302 to an affiliate tracker |

`cyberpour.com` was followed to completion: its title is "Simple and Fast Way to Download Files" and its
body is a registration form (`action="/cart.php"`). It is an affiliate funnel, not a file host, and it
carries no link to the audiobook. The plugin matches the torrent link on its own path so the three
monetisation links can never be chosen.

### Why bytes, and not a magnet

There is a documented third result for this contract, a magnet link. BookOrbit's plugin host does not
implement it: it calls `Buffer.from(result)` unconditionally, so a magnet throws. That is moot here
anyway, because a member session returns a **real `.torrent` file**, which is the branch stock BookOrbit
already handles. No patch, fork or local modification is needed.

A `.torrent` is never synthesised. A torrent is identified by its piece hashes, which only the real file
carries, so a constructed one would be rejected by every client.

### The grab sequence

1. `POST /member/login.php` with `username`, `password`, and the one-time `_formkey_` when the form
   publishes one. A redirect away from the form is success; a 200 that still carries the form is a
   rejection, checked on the body as well as the status.
2. Re-read the detail page with the session and extract the `/downld0` link.
3. Fetch it. A body starting with `0x64` is bencode; anything else (a login page starts with `<`) is
   treated as an expired session, which triggers one re-login and one retry.
4. Return the bytes, bounded by a 10 MB ceiling.

---

## 4. Audiobook import in BookOrbit

Recorded because it constrains what the plugin must state per release.

- Accepted audio formats: `m4b`, `mp3`, `m4a`, `opus`, `ogg`, `flac` (`scanner/lib/classify.ts:4`).
- A release that states formats where none is an audio format is **rejected** by the audiobook scorer
  (`indexers/release-scoring.ts:81-85, 150-159`), so `format` must be populated per release.
- Multi-file torrents are first-class: `interpretRelease` (`scanner/lib/release-plan.ts:143`) collapses
  all same-format audio files in a directory into one unit after folding `CD 1`-style subdirectories
  (`release-plan.ts:205-222, 266`). A 31-track mp3 pack becomes one audiobook and imports without
  intervention. The primary file is chosen by `FORMAT_RANK` (`release-plan.ts:341, 362`), where a lone
  `.m4b` outranks mp3 tracks, but every file is still placed.
- `seeders`/`leechers` must be `null`, never `0`: AudiobookBay states no swarm counts on a search page,
  and a zero would be read as a real count and trip the zero-seeder filter.
- `seedsBack` drives the UI's delivery label (`indexers/indexer-registry.ts:167`), so it must be `true`
  for a torrent source.

---

## 5. Search flow

```
search(query, config, host, signal)
  ├─ reject a non-audiobook mediaKind
  ├─ read settings (provider, strategy, formats, page depth, pace)
  ├─ warm a PHPSESSID (best effort)
  ├─ for each query variant, narrowest first:
  │    ├─ return early if the caller's signal has aborted
  │    ├─ GET /?s=<variant>&cat=undefined,undefined
  │    ├─ retry once on a 5xx, once after a pause if the answer was the front page
  │    ├─ verify the page <title> shows the query was answered
  │    ├─ parse result cards
  │    ├─ keep only cards sharing a meaningful word with the query
  │    └─ return if anything was found
  └─ nothing found
```

The deadline matters: BookOrbit gives each indexer **20 seconds** (`perIndexerTimeoutSeconds`, defaulted
at `indexer-manager.service.ts:53`) and aborts the signal when it expires. Every request is paced, so a
search that falls through several variants can approach that budget; the loop checks the signal before
each variant and gives up cleanly rather than being discarded mid-flight. A healthy search is one or two
requests and returns in about a second.

---

## 6. Settings

| key | type | default | notes |
| --- | --- | --- | --- |
| `username` | string | empty | Account email or username. Password goes in BookOrbit's credential field. |
| `provider` | string | `scrape` | `scrape` or `mock`. BookOrbit only allows `options` on a `list` field, so allowed values are stated in the hint and enforced at runtime. |
| `searchStrategy` | string | `title-author` | `title-author` or `title-only`. |
| `audioFormats` | string, `list` | `m4b,mp3,m4a,flac` | Releases whose format is not listed are dropped before pagination continues. |
| `maxPages` | number | `1` | 1-10, clamped. |
| `exactPhrase` | boolean | `false` | Quotes the query. AudiobookBay ANDs its terms, so this is strict. |
| `requestDelaySeconds` | number | `1` | 1-10, clamped. Paces every request. Raising it is the fix for throttling. |

`pace: false` is accepted by `readOptions` but is not a settings field: it is the offline suite's escape
hatch so 88 checks do not spend minutes waiting out a delay meant for a real host.

---

## 7. Verification

`node verify.mjs` — 88 offline checks, no network:

- the declared plugin shape against the rules BookOrbit's loader enforces, clause for clause, including
  the settings-field rules that rejected an early build at install time
- every parser against synthetic fixtures that reproduce the live site's quirks
- the whole member grab against a host stub: login form, `_formkey_`, session cookie, returned bytes
- the fetched torrent's info dict is sliced out and SHA-1'd, and the result compared with the info hash
  the detail page states — the same computation a BitTorrent client performs
- failure paths: no credential, no username, a rejected login, an HTML page where a torrent was
  expected, an empty body, an oversized body, no torrent link, a foreign host, a malformed URL, a
  capitalised query being lower-cased, and a throttled answer being refused and retried

The mirror of BookOrbit's shape rules is deliberately as strict as the original. An earlier version
validated `options` only inside the `format === 'list'` branch, so `options` on a plain field was never
examined — exactly the rule the build then failed on. Self-tests now assert that the mirror itself
rejects each thing it should.

`node live-validate.mjs` — developer-only, hits the real site, prints only structure (counts, field
presence, lengths). No titles, hashes, magnets or signed URLs, and no file content. With
`BOOKORBIT_ABB_USER` and `BOOKORBIT_ABB_PASS` set it also exercises a real member grab.

---

## 8. Known limitations

- **A full grab is not verified end to end** inside a running BookOrbit with a torrent client and a path
  mapping. Everything the plugin controls is covered; that last hop needs a deployment.
- **AudiobookBay is searched by keyword only.** It has no ISBN search, so an ISBN in the request is
  ignored and the title/author path is used.
- **The site changes.** Every behaviour in section 2 was measured, and any of them can change. The log
  messages name which condition was hit, which is what makes a future break diagnosable.

---

## 9. Automatic updates

BookOrbit's signed update channel, and the constraints that shape how it is wired.

### How discovery works

There is no central catalogue. The runtime file embeds its own channel in `UPDATE_CHANNEL`, and the
plugin exposes it as `update`:

```js
const UPDATE_CHANNEL = { manifestUrl: 'https://…/updates/audiobookbay.json', ed25519PublicKey: '…' };
```

BookOrbit reads `update.manifestUrl`, fetches the manifest, downloads the `sourceUrl` it names, and
installs only if both the SHA-256 and the detached Ed25519 signature verify against the embedded
public key. It re-checks every 12 hours (`plugin-update.service.ts:15`). The manifest shape it accepts
is fixed (`isManifest`): `schemaVersion`, `type`, `version`, an HTTPS `sourceUrl`, a 64-character
lower-case `sha256`, and a base64 `signature`.

`UPDATE_CHANNEL` is `null` until a release is signed, so the plugin installs and runs with no channel
and BookOrbit never checks for an update. Signing rewrites that one line.

### Three rules that follow from the implementation

- **Manifest and runtime ship together.** They are fetched separately, and either a digest or a
  signature mismatch is a hard refusal.
- **A local edit breaks the cycle.** State is `current` only when the installed file's digest equals
  the manifest's `sha256`; a hand-edited install becomes `custom` and stops updating.
- **An install with no embedded channel can never update itself**, so the first signed release must be
  installed by hand.

### Tooling

- `scripts/sign-update.mjs` substitutes the channel, hashes the exact runtime bytes, signs those same
  bytes, and writes the manifest. It refuses a private key inside the repository, requires an HTTPS
  update root, and checks the supplied public key against the private one when both are given.
  `--dry-run` prints the channel, manifest and digest without writing anything, which is what makes a
  wrong update root or a stale marker visible before a release.
- `scripts/verify-update.mjs` re-checks the manifest against BookOrbit's own rules.
  `--preflight` checks only that the runtime is packageable; `--selftest` needs no key and writes
  nothing, generating a throwaway Ed25519 pair and applying the same substitution to prove the digest
  and the signature verify. `npm test` includes it, so a broken marker or a changed signing input fails
  in CI rather than during a release.

The whole cycle was exercised end to end on 2026-10-12 with a throwaway key outside the working tree:
the channel was embedded, `updates/audiobookbay.json` produced, the manifest verified, and the signed
file loaded as a plugin with `update` present. The repository is left unsigned, since the update root
must name the real publication URL.
