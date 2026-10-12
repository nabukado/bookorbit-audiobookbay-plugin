# AudiobookBay indexer for BookOrbit

An [AudiobookBay](https://audiobookbay.lu/) indexer plugin for [BookOrbit](https://github.com/bookorbit/bookorbit), written against **BookOrbit plugin API v1**. It searches AudiobookBay for audiobooks by title and author, scores the results in BookOrbit's own picker, and downloads the picked release's real `.torrent` file using your AudiobookBay account.

This is a third-party plugin. It is not affiliated with BookOrbit or AudiobookBay.

## Compatibility

Reviewed against [BookOrbit v3.3.0](https://github.com/bookorbit/bookorbit/releases/tag/v3.3.0) on
**2026-10-12**. Its [plugin contract](https://github.com/bookorbit/bookorbit/blob/v3.3.0/packages/plugin-api/src/index.ts)
is API v1; the plugin declares `apiVersion: 1` and was checked against the loader's own
`assertPluginShape` rules, including the settings-field rules it enforces at install time.

**No BookOrbit patch, fork or modification is required.** `fetchTorrentFile` returns `.torrent` bytes,
which is the branch stock BookOrbit already implements, so a grab works on an unmodified instance.

Live behaviour was verified on the same date against `audiobookbay.lu`: search, metadata, member login
and the `.torrent` fetch. The endpoint behaviour this plugin depends on is recorded in
[ARCHITECTURE.md](ARCHITECTURE.md), so a future change on the site can be recognised rather than
debugged from scratch.

### What is verified, and what is not

- **Verified live:** search and metadata for several real titles, the member login, and a member fetch
  returning a real bencode `.torrent` (`application/x-bittorrent`, `content-disposition: …torrent`).
- **Verified offline:** 88 checks covering the parsers, the whole member grab against a host stub, and
  every failure path. The suite recomputes a torrent's info hash from the fetched bytes and compares it
  with the hash the detail page states.
- **Not verified end to end:** a complete grab inside a running BookOrbit with a torrent client and a
  path mapping configured. Everything the plugin controls is covered; that last hop needs a deployment.

If a search returns nothing, check the log first: the plugin distinguishes "the site served its front
page while rate limiting", "a server error", and "the deadline passed", rather than reporting a bare
zero.

## How it works

AudiobookBay serves its torrent files **only to a logged-in account**. This was measured directly:

| Client | `GET /downld0?downfs=...` |
| --- | --- |
| Guest | `200`, 88 bytes of HTML, a meta-refresh to `/member/login.php` |
| Member | `200 application/x-bittorrent`, 61,202 bytes, first byte `0x64`, `content-disposition: attachment; filename="<id>.torrent"` |

So the plugin logs in, fetches the `.torrent` with that session, and hands BookOrbit the bytes — the same shape the [myanonamouse plugin](https://github.com/orbit-plugins/bookorbit-plugins-extra/tree/main/indexers/myanonamouse) uses. **No BookOrbit patch, fork or modification is needed.** `fetchTorrentFile` returns bytes, which is the branch stock BookOrbit already implements, and your torrent client then downloads the audiobook from the swarm.

AudiobookBay's three other download links (`/dodl3-no`, `/dedl4-now`, `/hi-3dl`) are monetisation funnels: they redirect to `cyberpour.com`, a paid signup service (`action="/cart.php"`), and one is a plain affiliate tracker. The plugin never follows them. It only ever uses the Torrent Download link.

## Install

1. In BookOrbit, open **Settings > System > Requests > Sources** and choose **Install plugin**.
2. Upload [`indexers/audiobookbay/index.mjs`](indexers/audiobookbay/index.mjs). That one file is the whole runtime; there is no build step and no dependency.
3. Fill in **AudiobookBay username** with your account's email or username.
4. Put your **AudiobookBay password** in BookOrbit's **API key** field.
5. Leave **Provider** at `scrape`. The **Base URL** defaults to `https://audiobookbay.lu`; change it to whichever mirror you use.
6. Save the source and use **Test connection**.

A torrent download client (qBittorrent, Transmission or Deluge) with a path mapping must be configured in BookOrbit for a grab to be imported. AudiobookBay is declared `mediaKinds: ['audiobook']`, so it appears only for audiobook requests.

### Source settings

| Setting | Default | Purpose |
| --- | --- | --- |
| AudiobookBay username | empty | The account email or username. Its password goes in the API key field. |
| Provider | `scrape` | `scrape` for the live site, `mock` for the offline fixture. |
| Search strategy | `title-author` | `title-author` tries the decorated query, then title plus author, then title alone. `title-only` never sends the author. |
| Audio formats | `m4b,mp3,m4a,flac` | Formats to keep. A release whose format is not selected is dropped before pagination continues. |
| Max search pages | `1` | 1-10. The walk stops early once enough results are collected. |
| Prefer exact phrase | off | Quotes the query. AudiobookBay ANDs its terms, so this is strict; it falls back to unquoted when a page is empty. |
| Delay between requests | `1` | Seconds between requests. AudiobookBay rate limits. |

## What works

- Live search of AudiobookBay by title and author, with its legacy category parameter and `PHPSESSID` bootstrap.
- Relevance filtering, so a query ABB answers with its "latest" feed does not return the front page.
- Full card metadata: title, author (split from the `Title - Author` card format), format, size, language, bitrate, posted date and cover.
- Format filtering, page depth, exact-phrase search and a politeness delay.
- Member login, with the one-time `_formkey_` carried when the form publishes one.
- The real grab: the `.torrent` for the picked release, fetched with your session.
- An offline `mock` provider, so the plugin can be exercised with no network.

## Notes on behaviour

- **Queries are lower-cased, because AudiobookBay's search is case-sensitive.** `?s=Baldur` answers its generic front page; `?s=baldur` answers the book. Book metadata arrives capitalised, so this is not optional, and it was the cause of "Baldur's Gate 3 / T. Kingfisher" returning nothing.
- **Queries get shorter, not longer.** AudiobookBay ANDs its terms, so a decorated title can match nothing while one word finds the book. Variants are tried narrowest first, and only while the previous one returned nothing.
- **Two settings, one credential.** BookOrbit lends a plugin exactly one credential, so the password lives there and the username is a setting.
- **A rejected login never looks like a success.** A wrong password answers HTTP 200 with the login form back, not an error status, so the response body is checked as well as the status.
- **A lapsed session is retried once.** If the torrent link answers a page instead of bencode, the plugin discards the session, logs in again, and retries the same URL.
- **Transient failures do not fail a search.** A server error is retried, and a homepage that errors does not stop the search that follows it: measured 2026-10-12 the homepage answered HTTP 500 while the search answered normally.
- **Rate limiting is detected, not guessed at.** AudiobookBay drops a search under load and answers with its generic front page: HTTP 200, the query still in the URL, nine cards present. The status, the URL and the card count are all identical to a real answer, so the page `<title>` is what tells them apart ("Hail Mary Audiobook" against "Unabridged Audiobooks Free Online"). A dropped search is retried once after a pause, and if it is still dropped the plugin returns nothing and logs why.
- **The front page is never passed off as results.** This matters more than it sounds: the front page carries titles like "The Bear and the Serpent", so a search for "Dogs of War" would otherwise match it on the word "war" and return the wrong book.
- **Nothing is synthesised.** A torrent is identified by its piece hashes, which only the real file carries, so the plugin never fabricates one.
- **Swarm counts are `null`, never `0`.** AudiobookBay states no seeders or leechers on a search page, and a zero would be read as a real count.
- **Punctuation is normalised before searching.** WordPress texturises titles on output while ABB searches the stored ASCII text, so a curly apostrophe in a query matches nothing.

If searches come back empty and the log says AudiobookBay answered with its front page, that is the site
rate limiting you. Raise **Delay between requests** and search again after a minute.

## Development

```sh
npm test                    # 90 offline checks + the signing pipeline self-test, no network
npm run check               # syntax check every script
npm run preflight           # the runtime is packageable
npm run verify:release      # only once a release has been signed (needs updates/audiobookbay.json)
```

`verify.mjs` needs no network. It checks the declared plugin shape against the rules BookOrbit enforces before a plugin is called, exercises every parser against synthetic fixtures that reproduce the live site's quirks, and drives the whole member grab against a host stub: login, the `_formkey_`, the session cookie, the torrent's bytes, and every way it can fail. The torrent it uses is a real bencoded structure, and the test recomputes its info hash and compares it with the hash the detail page states. See [fixtures/README.md](fixtures/README.md).

`live-validate.mjs` is developer-only and reads the real site. It prints only structure (counts, field presence, lengths) and never titles, hashes, magnets or signed URLs. With credentials set it also exercises a real grab, capped and reporting only sizes and booleans:

```sh
BOOKORBIT_ABB_BASE_URL=https://audiobookbay.lu \
BOOKORBIT_ABB_QUERY="project hail mary" \
BOOKORBIT_ABB_USER='you@example.com' \
BOOKORBIT_ABB_PASS='your password' \
node live-validate.mjs --resolve-probe
```

`scripts/probe-member-download.mjs` is the credential-safe probe used to discover the endpoint behaviour above. Credentials come from the environment, are never printed or written to disk, and every fetch is capped at 400 KB.

## Signed updates

The plugin supports BookOrbit's signed update channel, and it is **active**: the runtime embeds the
channel for this repository, so an installed copy checks for updates every 12 hours. It is published at
[github.com/nabukado/bookorbit-audiobookbay-plugin](https://github.com/nabukado/bookorbit-audiobookbay-plugin).

### How BookOrbit finds an update

There is no central catalogue. The runtime file **embeds** its own channel:

```js
const UPDATE_CHANNEL = {"manifestUrl":"https://.../updates/audiobookbay.json","ed25519PublicKey":"..."};
```

BookOrbit reads that embedded `manifestUrl`, fetches the manifest, downloads the `sourceUrl` it names,
and installs it only if the SHA-256 matches the manifest **and** the detached Ed25519 signature verifies
against the embedded public key. It re-checks every 12 hours. Three consequences are worth knowing:

- **The manifest and the runtime must be published together.** They are fetched separately, and a
  mismatch in either the digest or the signature is a hard refusal.
- **A local edit breaks the cycle.** BookOrbit reports `current` only when the installed file's digest
  equals the manifest's `sha256`, so hand-editing an installed plugin turns it into `custom` and updates
  stop. Publish a new version instead.
- **An installed plugin that embeds no channel can never update itself.** The first signed release has
  to be installed by hand; after that, updates flow on their own.

### Publishing a release

1. Bump `VERSION` in [`indexers/audiobookbay/index.mjs`](indexers/audiobookbay/index.mjs).
2. Generate a signing key **outside this repository**, once. The `*.pem` files are gitignored as a
   backstop, and the signing script refuses a key that lives inside the repo:

   ```sh
   openssl genpkey -algorithm Ed25519 -out /secure/location/audiobookbay-ed25519.pem
   openssl pkey -in /secure/location/audiobookbay-ed25519.pem -pubout -out /secure/location/audiobookbay-ed25519.pub.pem
   ```

3. Sign **from the repository root** (the command uses relative paths, so run it from anywhere else
   and node reports `Cannot find module .../scripts/sign-update.mjs`; the `npm run sign` forms below
   avoid that entirely). This rewrites the embedded channel, writes `updates/audiobookbay.json`,
   hashes the exact runtime bytes and signs those same bytes. `--dry-run` prints what it would do
   without writing:

   ```sh
   BOOKORBIT_PLUGIN_SIGNING_KEY=/secure/location/audiobookbay-ed25519.pem \
   BOOKORBIT_PLUGIN_PUBLIC_KEY=/secure/location/audiobookbay-ed25519.pub.pem \
   BOOKORBIT_PLUGIN_UPDATE_ROOT=https://raw.githubusercontent.com/nabukado/bookorbit-audiobookbay-plugin/main \
   node scripts/sign-update.mjs audiobookbay --dry-run
   ```

4. Verify and ship. Commit the **signed runtime and the manifest together**:

   ```sh
   npm run verify:release   # digest, signature, and that the embedded and manifest URLs agree
   npm test
   ```

`npm test` covers the signing pipeline itself without needing a key: it generates a throwaway Ed25519
pair, applies the same channel substitution the signing script performs, and verifies the result. That is
what catches a broken marker or a changed signing input before a release rather than during one.

Credentials, session values, resolved magnets and raw live responses must never be committed. The
plugin logs no links and never logs the credential. It holds its session in process memory only.

## License and intent

Licensed under the **GNU Affero General Public License v3.0** ([LICENSE](LICENSE)), the same licence as
BookOrbit.

This plugin **ships and hosts no content**. It contains no audio, no `.torrent` files, no download
links and no credentials. It is a client that queries a public website and hands a `.torrent` to
BookOrbit, which then hands it to a torrent client that the operator has configured.

Every HTML fixture under [`fixtures/`](fixtures/README.md) is **synthetic**: hand-written markup that
reproduces the structural quirks of AudiobookBay's pages, with invented titles and authors. No real
page captures, release metadata, uploader names or torrent identifiers are included.

One honest caveat:

- This is a **BitTorrent index client**. It does not itself infringe anything, but downloading
  copyrighted audiobooks without permission is unlawful in most jurisdictions, and a public repository
  of this kind may attract DMCA notices regardless.

Intended for personal, self-hosted use against a source the operator is entitled to use. You are
responsible for how you use it; respect the laws that apply to you and AudiobookBay's own terms.
