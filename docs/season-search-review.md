# Review: Roadmap, Sonarr Season Search, and the Discord Response

Two things in one document, because they turned out to be connected: an audit of the tracking
roadmap against `main`, and a deep dive into the season-pack path — specifically the question
"what would we have to do to make it work the way a human has to work?"

Related code: [`src/season-pack.js`](../src/season-pack.js), [`src/arr.js`](../src/arr.js),
[`src/grab.js`](../src/grab.js), `sweepSeasonPacks` / `verifySeasonSearchCommand` in
[`index.js`](../index.js), and the pipeline overview in
[AvistaZ pipeline](avistaz-pipeline.md#season-pack-first-searching-old-shows-every-indexer).

---

## Part 1 — Roadmap audit

Tracking issue [#124](https://github.com/DurantTL/overseerr-dm-bot/issues/124) is stale. It was
last audited against `main` on 2026-08-15 and lists eight open items; seven of them have shipped
since, in a run of merges the issue body never picked up.

| Roadmap item | Landed as | State |
| --- | --- | --- |
| #126 — dedupe finished-watching prompts across Plex and Tautulli | — | closed |
| #128 — requester outcome notifications | `Notify requesters about stalled requests` (#149) | closed |
| #129 — persist rate limits and alert cooldowns | `Persist download limits and alert cooldowns` (#150) | closed |
| #130 — `*_FILE` credentials | `Support file-backed configuration secrets` (#151) | closed |
| #131 — backup observability and restore rehearsal | `Prove and report backup restorability` (#152) | closed |
| #132 — capacity forecast + cleanup suggestions | `Forecast storage capacity` (#153) | closed |
| #133 — extract and test Express route handlers | `Extract webhook route handlers` (#154) | closed |
| #134 — side-effect-free sweep previews | — | **open** |

So the real backlog is **one item: #134**, plus whatever comes out of Part 2. The "oldest-to-newest
implementation order" block at the bottom of #124 is entirely spent and should be replaced rather
than reordered.

Worth noting as process, not blame: the roadmap went stale because closing an issue doesn't touch
the tracking issue's checkboxes. Either the checkbox list becomes sub-issues (GitHub keeps those in
sync automatically) or #124 gets rewritten each time a batch merges. The first is less work
long-term.

---

## Part 2 — The season path, end to end

### What the code does today

```
sweepSeasonPacks()                       index.js:1001
  listSonarrSeries() + fetchArrQueues()
  skip: unmonitored, statistically complete, neither old nor requested
  getSeriesEpisodes(series.id)
  seasonSearchTargets(...)               src/season-pack.js:90
      assessSeriesAge   → ended / dormant ≥365d / requested
      planSeasonSearches → seasons where missing == aired, OR missing >= 3
      minus: seasons already in the Sonarr queue, minus: seasons inside the 24h cooldown
  triggerSeasonSearch(seriesId, season)  src/arr.js:286
      POST /api/v3/command { name: 'SeasonSearch', seriesId, seasonNumber }
  monitorSeasonSearch(...)               index.js:992
      pollArrCommand (15s poll, 10min deadline)
      re-read episodes + queue → outcome ∈ verified | partial | grabbed | no_grab | failed | timed_out
      notifyChannel('downloads', embed)
```

The gating logic in `src/season-pack.js` is genuinely good — pure, well-commented, well-tested, and
the age/dormancy/requested reasoning is the hard part of the problem. The problems are all
downstream of `triggerSeasonSearch`.

### Gap 1 — `SeasonSearch` is not "find the whole season in one file"

`src/arr.js:283-285` says the command "asks the indexers for the season as a whole, so a single
pack can satisfy every missing episode at once." That's the intent, but it isn't what Sonarr
guarantees:

- Sonarr chooses its own query shape. A fully-missing season gets a season-level query; a
  **partially** missing season is searched at episode/partial-season granularity. Our
  `minMissing >= 3` branch (`planSeasonSearches`, season-pack.js:74) deliberately targets partially
  missing seasons — so for a meaningful share of what this sweep fires, Sonarr is doing exactly the
  per-episode search the feature exists to avoid.
- Even on the fully-missing path, the season query returns packs *and* single episodes, and the
  decision engine grabs whatever scores best under the quality profile and custom formats. A pack
  is a candidate, not a preference. Nothing in Sonarr says "prefer one file for the whole season" —
  that preference lives only in our head and in this document.

**And we can't currently tell.** `verifySeasonSearchCommand` measures only `remaining` missing
count and matching queue rows. A season filled by one 18 GB pack and a season filled by twelve
grabs from twelve different release groups both record `outcome: 'verified'`. The metric that would
prove or disprove season-pack-first is the one we don't collect.

This is the finding I'd act on first — not because it's the biggest feature, but because every
other decision here is being made blind until it's fixed.

### Gap 2 — the interactive search API is unused

`grep -rn "api/v3/release"` across the repo returns nothing. Sonarr's interactive search — the
thing a human opens when automation comes up empty — is a single unauthenticated-by-us endpoint we
have never called:

```
GET  /api/v3/release?seriesId=<id>&seasonNumber=<n>
POST /api/v3/release   { guid, indexerId }
```

The GET returns every release the indexers offered, *including the ones the decision engine
rejected*, each with the reasons. Per release: `guid`, `indexerId`, `indexer`, `title`, `size`,
`seeders`, `leechers`, `protocol`, `fullSeason`, `seasonNumber`, `episodeNumbers[]`, `approved`,
`rejected` / `temporarilyRejected`, `rejections[]`, `qualityWeight`, `customFormatScore`,
`downloadAllowed`. The POST is the manual grab — it downloads the chosen release *whether or not
the decision engine approved it*.

`fullSeason: true` is, literally, "the whole season in one file," reported by Sonarr itself. We
have never looked at it.

### Gap 3 — the Discord response is a dead end exactly where it matters

`no_grab` (index.js:980-982) currently reads:

> Sonarr completed the search, but no release entered its queue and all **N** aired episodes are
> still missing. Run an Interactive Search from this season's header in Sonarr to distinguish no
> indexer results from releases rejected for quality, language, custom formats, size, seeders,
> blocklist, categories, or tags.

That message is well-written and correctly diagnoses the ambiguity — and then hands the ambiguity
to a human, in a channel, with no data attached and nothing to click. Every fact it asks the admin
to go find is in the GET from Gap 2. This is the single highest-value message in the whole season
path and it's the one carrying zero payload.

For contrast, the escalation watchdog's "Nothing Found Yet" alert (index.js:900-913) does this
right: the finding, the context, and `Escalate to AvistaZ` / `Ignore` buttons in the message.
That's the pattern to copy.

**Partially addressed.** These arrive in batches — one per season per sweep — so the verification
embeds were restructured from a prose paragraph into a short finding plus `Aired missing` /
`Sonarr command` / `In queue` / `Next step` fields, and the requester-facing progress DMs were
converted from plain text to branded embeds to match. That makes them scannable; it does **not**
give them a payload. The candidate list, rejection reasons, and grab button still depend on the
interactive search below.

### Gap 4 — two scoring brains that never talk

`src/grab.js` contains a full release-name parser and scorer: `parseReleaseName` (resolution,
source, season ranges, `seasonPack`, `multiSeason`, `E01-E30` runs), `scoreAvistazResult`
(title fit, year sanity for same-titled shows, quality, seeders, size sanity, freeleech, and a
zero-seeder cap), plus `releaseContentClaim` / `contentClaimsOverlap` / `planSeriesGrab` for
"grab the whole show without grabbing anything twice."

None of it touches the Sonarr path. The result is backwards: the bot exercises careful independent
judgement on the metered private tracker, and delegates entirely to Sonarr's decision engine on the
public indexers where mistakes are cheap and packs are common. The machinery to pick a season pack
already exists, tested, in this repo. It is pointed at the wrong half of the system.

---

## Part 3 — Making it work the way a human works

A human filling a gap in an old show does five things:

1. Opens the season and clicks **Interactive Search**.
2. Reads the *whole* list — including rejected rows, and why they were rejected.
3. Picks the one that is the whole season in one torrent, sane size, actually seeded.
4. Clicks grab, which overrides the decision engine's objection.
5. If nothing there is any good, says so and moves on.

Each step maps onto an API call we aren't making:

| Human step | API |
| --- | --- |
| 1. Interactive Search | `GET /api/v3/release?seriesId=&seasonNumber=` (blocks for the indexer query — needs the ~90s timeout `searchAvistaz` already uses, not the 10–15s default in `arr.js`) |
| 2. Read everything, rejections included | the `rejections[]` / `approved` fields on each row |
| 3. Pick the pack | `fullSeason === true` + `seasonNumber` match, ranked by the `grab.js` scorer |
| 4. Force the grab | `POST /api/v3/release { guid, indexerId }` |
| 5. Report honestly | the ranked list + rejection reasons, into Discord |

### Proposed shape

Keep the repo's existing split — pure decisions in `src/`, I/O thin, Discord in `index.js`.

**`src/season-release.js`** (new, pure, no Sonarr needed to test — same precedent as
`season-pack.js`):

- `classifySeasonRelease(release, { season })` → `{ isPack, coversSeason, sizeGb, seeders, rejections }`,
  built on the existing `parseReleaseName` so pack detection stays in one place and a release whose
  `fullSeason` flag disagrees with its name is visible rather than silently trusted.
- `rankSeasonReleases(releases, ctx, cfg)` → scored, sorted candidates, reusing `scoreAvistazResult`'s
  budget (title fit / year sanity / quality / seeders / size sanity, zero seeders capped).
- `chooseSeasonPack(ranked, cfg)` → `{ pick, why, runnersUp }`, or `{ pick: null, why }` — with a
  minimum confidence, minimum seeders, and a size band, so "nothing good enough" is a first-class
  answer rather than a fallback to the best of a bad list.
- `describeRejections(release)` → one short line for the embed.

**`src/arr.js`** (two thin additions):

- `interactiveSeasonSearch(seriesId, seasonNumber)` — the GET, long timeout, `audit` on failure like
  its neighbours.
- `forceGrabRelease({ guid, indexerId })` — the POST.

**Wiring in `index.js`:** run the interactive search on the `no_grab` and `partial` outcomes —
i.e. only after Sonarr's own attempt has already failed to fill the season. That keeps the extra
indexer load proportional and means the interactive path is doing precisely the job a human is
doing today.

### The honest caveat about forcing

Forcing a grab bypasses the decision engine, and the decision engine is frequently *right*: wrong
language, unwanted custom format, an upgrade the profile forbids, a blocklisted release, a size
limit that exists for a reason. "Grab it anyway" applied automatically will eventually pull in a
hardsubbed 480p pack over a perfectly good profile rule.

So the recommended sequencing is human-in-the-loop first:

- **Phase 1 (default on).** Interactive search on `no_grab`/`partial`, and post what it found: how
  many releases, how many full-season, and the top 3 with `size · seeders · indexer` and the first
  rejection reason each. No grabbing. This alone converts the dead-end message into an actionable
  one, and — importantly — it produces the data that settles Gap 1 empirically for *this* Sonarr
  version and *this* profile, instead of us reasoning about it from documentation.
- **Phase 2 (default on).** A `Grab this pack` button per top candidate, admin-gated via
  `isAdminInteraction`, audited on both offer and click, following the consumed-offer pattern
  `grab_dl` already uses. Note the 100-char custom-id limit: cache candidates under a nonce the way
  `mapimp_findm:` does — guids will not fit in a custom id.
- **Phase 3 (default OFF).** Auto-force under a confidence bar, for admins who've watched Phase 2
  make the right call for a few weeks. Gate it behind the existing `season_pack` group in
  `src/runtime-settings.js` so it's dashboard-tunable and reversible without a redeploy.

New settings, all in the existing `season_pack` group: `SEASON_PACK_INTERACTIVE` (bool, default on),
`SEASON_PACK_FORCE_GRAB` (bool, default **off**), `SEASON_PACK_MIN_SEEDERS`,
`SEASON_PACK_MAX_SIZE_GB`, `SEASON_PACK_MIN_CONFIDENCE`.

Two guard rails that already exist and should be reused rather than rebuilt: `releaseContentClaim` /
`contentClaimsOverlap` to refuse a force-grab for a season an active grab job already covers, and
the season cooldown so an interactive search doesn't fire every sweep on a season with genuinely
nothing available.

### The partial-season honesty fix

Independent of everything above, the sweep embed (index.js:1056) tells the admin:

> Sonarr was asked for these seasons as a whole instead of episode by episode

For seasons on the `missing >= minMissing` branch, that isn't what Sonarr does. Either route those
seasons through the interactive path (where a pack is visible and grabbable, and Sonarr discards the
episodes it already has on import) or change the wording. Small, but it's a claim the code doesn't
back.

---

## Suggested backlog

Ordered so each step de-risks the next. Items 1 and 2 are worth doing even if 3–5 never ship.

1. **Record how a season was actually filled.** Extend `season_pack_search_result` with pack-vs-episode
   detail from the queue/history, and split the `verified` embed accordingly. Answers Gap 1 with data.
2. **Fix the partial-season claim** in the sweep embed. One-line honesty fix.
3. **`src/season-release.js` + the two `arr.js` calls.** Pure and testable; nothing user-visible yet.
4. **Phase 1 Discord response** — interactive search results with rejection reasons on `no_grab`
   and `partial`, replacing the "go do it yourself in Sonarr" dead end.
5. **Phase 2 `Grab this pack` button**, admin-gated and audited.
6. **Phase 3 `SEASON_PACK_FORCE_GRAB`**, default off, behind a confidence bar.
7. **#134** — side-effect-free sweep previews. Unchanged from the existing roadmap, and it composes
   well with 4–6: a dry-run that shows which pack *would* be forced is the natural way to trust
   Phase 3.
