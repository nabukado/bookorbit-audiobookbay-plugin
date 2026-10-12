# Fixtures

All fixtures here are **synthetic**: hand-written HTML that reproduces the structural quirks of
AudiobookBay's pages, with invented titles and authors. No real page captures are included, so nothing
in this directory is anybody's catalogue data, personal information or torrent identifier.

They are kept because HTML fixtures are the only cheap way to catch the parser drift that breaks this
kind of scraper. Each one pins a specific shape that has caused a real bug or would cause one.

| Fixture | What it pins down |
| --- | --- |
| `search-results-page.html` | A full answer: front-page "latest" entries the relevance filter must drop, then the results that match. Carries the nested `<div class="center">` inside `.postContent`, `&nbsp;` runs, an entity-encoded apostrophe and dash, sizes split across a styled `<span>`, relative and absolute cover URLs, a non-English card, and a title with no ` - ` separator. The page `<title>` is `Hail Mary Audiobook`, which is how the plugin tells a real answer from the front page. |
| `detail-torrent-page.html` | A torrent's metadata table: a lower-case info hash, five trackers as their own rows, the "This is a Multifile Torrent" marker and file table, and **one real download route plus four that are not** — three pointing at a paid signup path and two at an affiliate path. The parser must pick `/downld0` and ignore the rest. |
| `search-dom-drift.html` | A changed results DOM must degrade to zero results, never crash. |
| `search-typographic-title.html` | Curly quotes and dashes in a title, a relative cover URL, an `MP3`/`128 Kbps` card, and a `1.5 GBs` size. |
| `detail-messy-hash.html` | An info hash that arrives lowercase and split across lines, plus a two-file table. |
| `detail-magnet-fallback.html` | A junk Info Hash cell recovered from an in-page `magnet:` link. |
| `detail-no-hash.html` | No hash and no magnet anywhere: a clean `null`, never a malformed magnet. |
| `detail-login-gate.html` | The shape AudiobookBay answers a download link with when there is no session: HTML, and a `0x64` check proves it is not bencode. |
| `detail-single-file.html` | A single-file torrent with no "Multifile" marker and no file table. |
| `detail-member-download.html` | The member detail page, carrying the `/downld0` link the grab follows. Its info hash is the real SHA-1 of the bencoded torrent the suite builds, so the test that recomputes the hash is meaningful. |

## Why these are synthetic

Earlier revisions of this repository contained three pages captured from the live site. They were
useful — they exposed parsing bugs that cleaner hand-written samples had hidden — but they contained
real release titles and authors, third-party uploader usernames, Gravatar URLs, third-party cover image
references, and a real BitTorrent info hash. None of that belongs in a public repository, and
redistributing a catalogue extract raises database-right questions in some jurisdictions.

The quirks they exposed have been reproduced here deliberately, so the same bugs stay covered without
redistributing anyone's data. The live behaviour they documented is recorded, with dates, in
[../ARCHITECTURE.md](../ARCHITECTURE.md), and [`../live-validate.mjs`](../live-validate.mjs) re-checks
the real site on demand.

The two failures that motivated the original captures are both still covered: card fields being lost to
the nested content `<div>`, and the front page's "latest" entries being mistaken for results.
