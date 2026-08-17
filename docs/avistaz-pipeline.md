# AvistaZ Pipeline: Private-Tracker Fallback, Season-Pack-First Search, Direct Grab

This is the bot's private-tracker fallback stack for content public indexers can't find: an
escalation gate that decides when a title is even eligible for AvistaZ, a Sonarr-wide season-pack
sweep that isn't AvistaZ-specific, and the direct-grab pipeline that searches, scores, and
transfers AvistaZ releases itself instead of leaving Radarr/Sonarr to grab on their own judgement.

See the main [README](../README.md#avistaz-private-tracker-fallback--direct-grab) for a one-line
pointer back, and [Policy review: AvistaZ private-tracker automation risk](https://github.com/DurantTL/overseerr-dm-bot/issues/65)
for the product/policy framing (admin-approval-by-default, daily grab limits) this pipeline
operates under.

## AvistaZ Private-Tracker Fallback
Public indexers (→ Premiumize) always get first crack at every request. AvistaZ is only used as a
per-title fallback, which conserves its download slots / ratio and keeps private grabs seeding on a
seedbox instead of Premiumize.

> When the **direct grab** pipeline (next section) is fully configured, TV escalation routes
> through it first. Movie escalation stays on the tag + Radarr search path; TV falls back to the
> tag mechanism when the direct search fails or finds nothing.

**Why not Prowlarr priority?** Priority is only a tie-breaker — Radarr/Sonarr grab the
best-scoring release regardless of which indexer returned it. The strict mechanism is **indexer
tags**: an indexer with a tag only applies to movies/series that carry the same tag. The AvistaZ
indexer is tagged, no title carries the tag by default, so nothing ever hits AvistaZ until the bot
"escalates" a title by adding the tag to it and re-searching.

### What escalates on its own, and what asks first
AvistaZ is an **Asian-content tracker** — East, Southeast and South Asian movies and TV, plus
anime. It has nothing else, so escalating a title it can't possibly carry burns a metered tracker
search (and sometimes a download slot on a wrong match somebody then has to notice and delete).
Auto-escalation is therefore narrower than pre-authorization:

| Title | Pre-authorized | What happens after the delay |
| --- | --- | --- |
| TV, obviously Asian | yes | **escalates automatically** |
| TV, obviously Asian | no | button alert |
| TV, not obviously Asian | either | button alert |
| Movie, obviously Asian | yes | **tags the movie and triggers Radarr automatically** |
| Movie, obviously Asian | no | button alert |
| Movie, not obviously Asian | either | button alert |

"Obviously Asian" is decided from the title's TMDB record, which Overseerr already serves: an
Asian **original language**, an Asian **production/origin country**, or an **original title in an
Asian script** (kana, hanzi, hangul, Thai, Devanagari, …). Any one of those is enough — AvistaZ
carries English-language Asian productions too, and a Korean-language US co-production is still
Korean. Central and West Asia (Turkey, Israel, the Gulf, the -stans) are deliberately out of scope
because the tracker doesn't cover them.

The verdict is three-valued, and only a decided one is cached on the watch row. If Overseerr is
unreachable or the TMDB record is bare, the answer is **unknown** — which asks a human rather than
guessing in either direction, and is re-checked on the next sweep.

**Clearly Asian movies can auto-escalate when pre-authorized, but they stay inside Radarr.** The
bot adds the AvistaZ tag and triggers Radarr's normal movie search; it does not run the direct
candidate/seedbox pipeline for movies. Radarr's quality profile, custom formats, blocklist, and
release matching therefore remain the acceptance boundary. Non-Asian or unknown-origin films
still get the button.

Being asked isn't a dead end — the **Escalate to AvistaZ** button does exactly what the automatic
path would have done, and the alert embed carries an **AvistaZ fit** line explaining the verdict so
the call is an informed one.

### How the bot uses it
- The approval embed gets a third button, **Approve + AvistaZ Fallback**, which pre-authorizes the
  fallback: the `avistaz` tag goes onto the title in Radarr/Sonarr right at approval (it's
  definitely AvistaZ-bound), and if nothing public has been grabbed within
  `ESCALATION_DELAY_MINUTES` the bot escalates — automatically for an obviously-Asian title, via
  the button for anything else (see the table above).
- Plain **Approve** gets the watchdog flavor instead: after the delay, the downloads channel gets
  a **⏳ Nothing Found Yet** embed with **Escalate to AvistaZ / Ignore** buttons.
- Admin self-requests skip the gate entirely (no button to click), so they're pre-authorized
  automatically — tagged at request time, and subject to the same Asian-origin auto-escalation
  rule as **Approve + AvistaZ Fallback**. Movies trigger Radarr's search; TV may use the direct
  seedbox planner before falling back to Sonarr's search.
- A watch row resolves automatically the moment the media turns available, starts downloading, or
  the request is declined; unresolved rows expire after `ESCALATION_MAX_AGE_DAYS`.
- If an approved request never lands in Radarr/Sonarr at all — Seerr can accept a request and
  lose it moments later (its log shows `Media data not found`, usually a broken TMDB↔TVDB
  mapping) — the bot repairs it after `ESCALATION_ARR_GRACE_MINUTES` (default 10). A
  **pre-authorized** request is fixed automatically: the title is added directly to the arr
  (bypassing Seerr; AvistaZ tag included) and the downloads channel just gets told. Anything
  else gets a **🕳️ Request Never Landed** alert with an **Add to Sonarr/Radarr & Search**
  button that does the same add on click. Direct adds use `SONARR_ROOT_FOLDER` /
  `SONARR_QUALITY_PROFILE` etc. when set, else the arr's first root folder / quality profile.
  The escalation clock restarts from the add, so public indexers get the full delay before
  any fallback.
- 4K requests are never escalated (the fallback is for hard-to-find content, not 4K upgrades).
- Clicking **Escalate to AvistaZ** by hand is never blocked by the origin check — it's an
  override for exactly the cases the automation won't take on its own.

### One-time arr/Prowlarr setup
1. **Prowlarr**: add the AvistaZ indexer (needs your AvistaZ account; mind its seeding rules).
2. **Get it into Radarr + Sonarr with a tag that sticks.** Caveat: Prowlarr *Full Sync* overwrites
   manual indexer edits on every sync. Either set the Prowlarr application sync level to
   *Add and Remove Only* and then tag the indexer inside Radarr/Sonarr, or add AvistaZ directly in
   Radarr/Sonarr as a Torznab indexer pointed at Prowlarr's AvistaZ feed URL.
3. **Tag the indexer** in Radarr → Settings → Indexers → AvistaZ → Tags → `avistaz` (must match
   `AVISTAZ_TAG`), and the same in Sonarr. This tag gate is the entire strictness mechanism.
4. **Do NOT tag it in the 4K Radarr instance** — 4K escalation is out of scope by design.
5. **Route AvistaZ downloads to the seedbox**: add Deluge (or your seedbox client) as a download
   client in Radarr/Sonarr, then on the AvistaZ indexer set *Download Client → Deluge*. Public
   indexers keep using the Premiumize client. Disable completed-download removal / seeding-goal
   teardown for the Deluge client so private grabs keep seeding.
6. Set `ESCALATION_ENABLED=true` (plus any of the other `ESCALATION_*` keys) and restart the bot.
7. Verify: the bot warns at startup (log + system channel) if the `avistaz` tag is missing in
   Radarr or Sonarr, and `/indexers` shows AvistaZ health via Prowlarr.

### Operational caveats
- The tag is **never auto-removed** after an escalation — it marks which titles came from AvistaZ
  (seeding traceability), and future upgrades of that title may search AvistaZ again. Remove the
  tag from the movie/series manually if you want it back on public-only.
- The stuck-download **Remove & Try Another Release** button blocklists the release; on an AvistaZ
  grab that blocklists a private-tracker release.

## Season-Pack-First Searching (old shows, every indexer)
Sonarr looks for missing episodes **one at a time**. For a show that's still airing that's
right — episode 8 aired last night and no season pack exists yet. For a drama that finished in
2007 it's the expensive way to get something that exists as a single torrent: 30 searches, 30
grabs, 30 release groups, and on a metered private tracker 30 download slots for what one pack
would have cost.

`SEASON_PACK_FIRST` (default on) sweeps Sonarr every `SEASON_PACK_CHECK_MINUTES` (default 180)
and asks for a **SeasonSearch** on each incomplete season of each old show — one search for the
whole season, so a pack can satisfy every gap at once. This runs against whatever indexers
Sonarr already has; it is not AvistaZ-specific and needs none of the direct-grab pipeline.

A show counts as **old** when Sonarr marks it `ended`, or when nothing has aired in
`SEASON_PACK_DORMANT_DAYS` (default 365) and nothing is scheduled. A scheduled next airing always
wins — a series returning next week is current whatever its status field says, and its latest
season is still being released weekly.

**Requested shows skip the age gate entirely** (`SEASON_PACK_REQUESTED`, default on). Most
releases are an `S01` season pack whatever the show's age, and somebody is waiting on a show they
asked for, so a current series with a request behind it gets the same treatment. A show counts as
requested when it appears in the bot's `requests` or `escalations` tables under its TVDB id. This
stays safe on a live season because only **aired** episodes count toward the missing threshold —
a season halfway through its run has nothing to search for until episodes actually go missing,
and a season that's already up to date is never searched at all. The downloads-channel summary
says which reason applied per season (`series has ended` vs `requested`).

A season is searched when:
- it has **aired, monitored, file-less** episodes (unaired ones can't be downloaded; unmonitored
  ones were excluded on purpose), **and**
- the whole aired season is missing, **or** at least `SEASON_PACK_MIN_MISSING` (default 3)
  episodes are. One or two gaps fall through to Sonarr's normal per-episode search on purpose —
  pulling a 20 GB pack to fill a single hole wastes more bandwidth than it saves.

Specials (season 0) are never packed. A season already downloading is skipped rather than raced,
and each season honors `SEASON_PACK_COOLDOWN_HOURS` (default 24) so a season with nothing
available isn't re-searched every sweep. `SEASON_PACK_MAX_PER_RUN` (default 5) keeps a first pass
over a large library from firing hundreds of indexer searches at once. Searched seasons are
posted to the downloads channel and audited as `season_pack_search`.

Nothing in your Sonarr configuration is touched — no profiles, no custom formats, no release
profiles. The bot only issues search commands, so turning `SEASON_PACK_FIRST=false` back off
returns Sonarr to exactly its previous behavior. Whatever Sonarr grabs imports normally.

Repeated identical `no_grab` results do not repeat in Discord forever. The bot still performs
every eligible search, but posts attempts 1, 2, and 4; attempt 4 announces that alerts are standing
down. The durable state is per series and season and survives restarts. A changed aired-missing
count, interactive release list, approval/rejection result, or quality/custom-format score starts a
fresh alert sequence. A dashboard or `/automation` manual retry also re-arms the seasons it
actually searches. Stood-down seasons remain visible under **Automation → Season-search alert
stand-downs**, including attempt count, last try, and a manual re-arm action.

The [episode recovery watchdog](episode-recovery.md) stands down on any season this path
owns: recovering an old season one episode at a time is the waste this exists to prevent, and on
AvistaZ the two would race for the same download slots. Seasons that fall below the pack
threshold go back to episode-level recovery.

## AvistaZ Direct Grab (Prowlarr search → seedbox rTorrent → rclone → arr import)
The next stage of the fallback above. Instead of handing the search to Radarr/Sonarr via the
indexer tag (where the arrs grab whatever scores best and burn AvistaZ download slots on their
own judgement), the bot runs the whole chain itself:

```text
Escalation fires (or /avistaz search)
        ↓
Bot searches AvistaZ through Prowlarr (never scrapes the website)
        ↓
Bot scores each release: title/year match, season pack vs episode,
resolution/source, seeders, size sanity, freeleech, already-downloaded
        ↓
Auto-grab (GRAB_MODE=auto + high confidence) or Discord approval buttons
        ↓
.torrent pushed to seedbox rTorrent (raw bytes over XML-RPC) with the
radarr/sonarr label — the seedbox can't reach Prowlarr, so the bot fetches
the file and computes the info-hash locally for tracking
        ↓
Bot polls rTorrent until the download completes (seeding continues there —
private-tracker ratio lives on the seedbox)
        ↓
rclone copy into GRAB_STAGING_PATH/.incoming, then renamed into place so the
arr never sees a half-copied folder
        ↓
Radarr DownloadedMoviesScan / Sonarr DownloadedEpisodesScan (importMode Move)
→ normal import, renaming, notifications; Bazarr picks up subtitles; Plex updates
```

### Modes
- **Automatic** (`GRAB_MODE=auto`): escalations grab the top candidate themselves when its
  confidence ≥ `GRAB_AUTO_CONFIDENCE`; anything less confident falls back to approval buttons.
  For a series this grabs the whole available run, not just the top release (see below).
- **Approval** (`GRAB_MODE=approve`, default): escalations post the top 3 scored candidates to
  the downloads channel with **Download 1/2/3 / Cancel** buttons, plus **Grab Everything** for a
  series.
- **Manual**: `/avistaz search title:<...> type:movie|tv [season] [year]` any time;
  `/avistaz status` shows the allowance, mode, seedbox reachability, and active grabs.

### Whole-series grabs
A **Download** button grabs exactly one release and consumes the offer — so a show whose best
AvistaZ match is a single season (or a single episode) used to get that one release and never
prompt again. `GRAB_TV_COMPLETE` (default on) fixes that: TV searches rank the full result set
instead of just the podium, and the bot plans a set of releases whose episode-spaces **don't
overlap** — a complete-series pack, or a pack per season, plus any loose episodes that fill the
gaps. That plan sits behind one **Grab Everything (N)** button, and in `GRAB_MODE=auto` the
escalation takes the whole plan by itself once the top match clears `GRAB_AUTO_CONFIDENCE`.

Releases are picked **widest first** — complete series, then season packs, then loose episodes —
and only then by confidence. Confidence alone gets this backwards on exactly the shows the
feature exists for: an old drama's complete pack is typically a 2-seeder 720p rip (~80%) while
someone's re-encode of episode 1 is a 12-seeder 1080p WEB-DL (~84%), so the lone episode would
anchor the plan and the pack holding all thirty episodes would be dropped as "already covered".
`GRAB_TV_COMPLETE_MIN_CONFIDENCE` still gates entry, so a dead or mislabelled pack can't ride
breadth past the quality bar.

**Same-titled shows are told apart by year.** "Full House" is both a 1987 US sitcom and a 2004
Korean drama, and the TV scoring path never looked at the year — `Full House S01 1987` and
`Full House S01 2004 1080p KOCOWA WEB-DL` scored identically, so the wrong show could win a plan
outright. A release that *predates* the series now takes a 25-point penalty and says so in the
candidate embed. It's a penalty rather than points because a TV release's year is usually the
**season's** air year: `Show S03 2015` on a series that began in 2012 is correct and is left
alone. Only a first season dated well after the series began (a remake) takes a smaller hit.

Season-less episode runs (`E01-E30`, how single-season Asian dramas are usually uploaded) and the
old `1x05` form are recognized as well — they used to parse as nothing at all, which made the
only pack on offer invisible to the planner. A multi-episode file (`S01E01-E10`) claims its whole
run, so a second release of `E02-E10` is caught as a duplicate.

The plan is built from the same episode-space claims as the dedupe above, so it can never spend
two download slots on the same episodes, and releases already in flight are excluded — re-running
`/avistaz search` after a partial grab only offers the gaps. Only the search's top-scoring series
is planned, so other shows in the result set are never swept in. Releases join a plan at
`GRAB_TV_COMPLETE_MIN_CONFIDENCE` (default `70`) — below `GRAB_AUTO_CONFIDENCE` on purpose, since
the top match must clear that bar on its own before any bulk grab starts.

Size is bounded by `GRAB_TV_MAX_RELEASES` (default `6`) **and** by whatever is left of
`AVISTAZ_DAILY_GRAB_LIMIT`, whichever is smaller; the allowance is re-checked between releases, so
a plan that outgrows the day stops cleanly and says how many are left rather than overspending.
Set `GRAB_TV_COMPLETE=false` to go back to one-release-per-click.

Episodes that air *later* are a different problem — that's the
[episode recovery watchdog](episode-recovery.md), which watches monitored series for aired
episodes that never landed. Whole-series grabs cover what AvistaZ has **now**, at request time.

### Allowance
Every grab (failed attempts included — the tracker may count the download the moment the
`.torrent` is fetched) consumes one slot of `AVISTAZ_DAILY_GRAB_LIMIT` per UTC day, so
automation can't drain a limited AvistaZ account. Scoring prefers season packs for exactly the
reason the limit exists: one grab can deliver a whole season. Multi-season / complete-series
releases (`S01-S05`, `Complete Series` — common for older shows that only exist as one big
torrent) are recognized too: they score as covering any requested season in their range, show up
labeled "complete series" in the candidate embeds, and Sonarr sorts the episodes into the right
seasons at import (per-file `SxxEyy` parsing — Sonarr's own automatic search can't grab
multi-season packs, which is why the direct pipeline handles them). Duplicate info-hashes are
refused outright ("already grabbed as job #N").

**Content-level dedupe** (`GRAB_CONTENT_DEDUPE`, default on) goes a step further than the info-hash
check: it blocks a grab **or** an adoption when an active job already covers the same episode(s) —
even a *different release, encoding, or size* of them, which the info-hash and exact-title checks
can't see. The release name is reduced to the episode-space it claims (series + seasons/episodes,
with a season pack or "complete series" covering everything in it) and compared against active
jobs; an overlap is refused ("already grabbing S01E14 as job #N"). It's deliberately conservative —
an unparseable name makes no claim and is never blocked, so a genuinely different episode is never
lost. Movies dedupe by resolved media id. Set `GRAB_CONTENT_DEDUPE=false` to allow multiple
releases of the same content through.

### Setup
1. Add the AvistaZ indexer in **Prowlarr** (the bot finds it by name via `AVISTAZ_INDEXER_NAME`).
2. Set `RTORRENT_URL` to the seedbox's XML-RPC endpoint incl. credentials — RapidSeedbox
   exposes it at `/plugins/rpc/rpc.php`, e.g.
   `https://user:pass@server.rapidseedbox.com/plugins/rpc/rpc.php`.
3. Configure an rclone remote that reaches the seedbox's rTorrent download folder (SFTP works
   well) and set `GRAB_RCLONE_REMOTE` (e.g. `rapidseedbox:files`) plus
   `GRAB_RCLONE_FLAGS=--config /app/data/rclone.conf` and any SFTP tuning.
4. Mount a **writable** staging folder into the container (the media mount is `:ro` — see the
   commented volume in `docker-compose.yml`) and set `GRAB_STAGING_PATH`; set
   `GRAB_IMPORT_PATH` to the same folder as Radarr/Sonarr see it.
5. Restart. When the pipeline is fully configured, escalations use it automatically and fall
   back to the tag-based flow only when the AvistaZ search fails or finds nothing.

Grab jobs are durable (`grab_jobs` in SQLite): a restart mid-download keeps watching, a restart
mid-transfer re-queues the copy, and rclone skips already-transferred files. Transfer failures
alert the downloads channel with a **Retry Transfer** button.

### Guided import ("Map to a Series…")
When Sonarr declines an import (`Unknown Series` — TVDB files the show under another title,
common for Asian dramas whose sequels are listed as a season of the original; or fansub names
with no `SxxEyy` to parse), the decline alert carries a **Map to a Series…** button that runs
Sonarr's Manual Import as a short conversation in the downloads channel: pick the series
(library fuzzy-matched, recently-added first, with a search-by-name modal), pick the season,
review the file→episode mapping (episode numbers read from filenames when possible, natural
order otherwise — mismatches are called out), confirm. The bot then pushes the exact mapping
through Sonarr's ManualImport API (move mode). `/rtorrent import` in move mode gets the same
post-scan verification, so silent declines there surface with the wizard too. Wizard state
lives in SQLite, so a bot restart mid-conversation doesn't strand the message.

### Adopting existing torrents (`/rtorrent adopt`)
The pipeline above tracks torrents by the info-hash the bot computes when **it** submits the
`.torrent` — anything added to rTorrent by hand, by another private tracker's automation, or
before the bot existed has no `grab_jobs` row and is invisible. Adoption closes that gap,
provider-independently:

```text
/rtorrent adopt search:"Blood Vs Duty" [target:sonarr|radarr]
        ↓
Bot queries every torrent in rTorrent (d.multicall2) and matches names
        ↓
Embed shows name, progress, size, and label, with Adopt buttons
(target from the rTorrent label; blank/unknown labels get an explicit
per-arr button — nothing is ever adopted on a guessed target)
        ↓
Admin clicks Adopt → a grab job is created for the EXISTING info-hash
at 'downloading' (watched to 100%) or 'complete' (transfers immediately)
        ↓
The normal chain finishes it: rclone → .incoming → rename → arr import
```

Safety properties, by construction:
- **Never** downloads a `.torrent` from AvistaZ (or anywhere) and **never** consumes an
  `AVISTAZ_DAILY_GRAB_LIMIT` slot — adopted jobs (`origin` `adopt`/`adopt-auto`) are excluded
  from the allowance count.
- **Never** removes the torrent or its data from rTorrent — transfers are `rclone copy`, and
  seeding continues on the seedbox.
- An info-hash already in `grab_jobs` is refused ("already tracked as job #N").
- The matching file/folder must exist under `GRAB_RCLONE_REMOTE` **before** the job is created.
  The probe self-corrects the path mapping: it tries the `RTORRENT_REMOTE_ROOT`-derived subpath
  (optional — the seedbox-side folder the remote points at), the bare torrent name, and every
  trailing suffix of the torrent's `d.base_path` — so an SFTP remote rooted at the login home
  dir (where files appear as `Downloads/…`) still resolves. If every probe misses, a one-off
  recursive listing searches the whole remote by exact torrent name (unique matches only —
  ambiguity is refused, never guessed), catching data that was sorted into folders behind
  rTorrent's back. Failures report exactly which paths were probed, and `/rtorrent status`
  previews what the remote root actually contains.
- Adopted jobs are durable `grab_jobs` rows — restarts keep watching/transferring them, and the
  `.incoming` rename guard applies unchanged.

**Import verification**: a grab job is never marked done just because the arr's scan command
was *fired* — it moves through `scanning` → (`importing` if a forced ManualImport runs) →
`verified`, and only `verified` counts as actually imported. After every transfer's arr scan,
the bot checks the video files actually left staging. A scan that never completes leaves the
job at `scanning` and raises a "command queue may be wedged" alert; a scan that completes but
silently skips cleanly-matched files gets them forced through the arr's ManualImport API only
when `SONARR_AUTO_MANUAL_IMPORT=true` **and** the job is pinned to a single resolved Sonarr
series (see "Sonarr series identity" below) — otherwise it goes to `needs_mapping` (TV) or
`import_rejected` (movies) with the guided **Map to a Series…** wizard offered for TV;
genuinely rejected files land there too, with one alert naming the rejection reasons.
`/rtorrent staging` runs the same match/rejection analysis on demand, summarized per staging
folder.

### Sonarr series identity
Both a normal request grab (when the request already carries a TVDB id) and adoption resolve
the Sonarr `seriesId` **before** the job is created, instead of leaving Sonarr to guess from
the release filename at import time — the guess is where foreign titles, alternate names,
sequels filed as a season of the original, and complete-series packs go wrong. Resolution
order: TVDB id (authoritative when known) → exact normalized-title match → alternate-title
match → nothing (Sonarr still gets the files and guesses on its own, unchanged from before).
A title matching **more than one** Sonarr series blocks adoption for one admin click (a
**Which Series?** picker) instead of guessing; `/rtorrent adopt` surfaces those separately
from outright failures, and re-adopting one at a time offers the picker. The resolved
`target_arr_id`/`tvdb_id`/`match_type` on the `grab_jobs` row is what gates the auto-forced
ManualImport above — `match_type` is never `'ambiguous'`, since an ambiguous match never
reaches a job row unresolved.

Commands: `/rtorrent status` (connectivity + adoption settings), `/rtorrent list [search]`,
`/rtorrent adopt search:"..." [target:]`, `/rtorrent ignore search:"..."` (toggle — the sweep
skips ignored torrents), `/rtorrent adopted` (adopted jobs + ignore list), and
`/rtorrent import target: [folder:] [mode:move|copy]` — hand a staging folder straight to the
arr's DownloadedScan, for files that got into staging outside the pipeline (manual rclone
copies). `mode:copy` leaves the staging files in place; importing from `.incoming`, or the
staging root while a transfer is mid-copy, is refused.

**Bulk adoption**: when the search matches more than 3 untracked torrents (an
episode-per-torrent series can be 80+), the offer collapses to a single **Adopt all N**
button. One target applies to the whole batch (from `target:`, or from the labels when they
all agree — mixed/blank labels get one button per arr). Existence checks are batched (one
directory listing per unique seedbox folder instead of a stat per torrent), duplicates are
skipped quietly so a re-run after a partial failure only adopts what's still missing, and a
single summary reports adopted/skipped/failed counts. Completed torrents still transfer one
at a time — the WAN link is the bottleneck — and each import triggers its own arr scan.
Transfer progress for adopted batches is a single rolling embed in the downloads channel,
edited in place per import (one notification per batch, not one per episode), replaced by a
completion summary when the batch drains.

With `RTORRENT_ADOPT_ENABLED=true`, a **discovery sweep** (every `RTORRENT_ADOPT_CHECK_MINUTES`)
looks for torrents whose label is in `RTORRENT_ADOPT_LABELS` but which have no grab job, and
posts **one** message to the downloads channel covering the whole cohort — a bulk Adopt-all
offer when more than 3 are waiting, per-torrent buttons otherwise. Every posted candidate is
marked offered (durably, per info-hash), so nothing is re-posted unless new torrents appear.
`RTORRENT_ADOPT_AUTO=true` makes the sweep adopt label-resolved candidates outright; keep it
`false` initially so the bot only discovers candidates instead of transferring every completed
torrent on the seedbox.
