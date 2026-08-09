# Episode Recovery Watchdog

The request-level AvistaZ escalation resolves once a TV series has any file or queue activity. That
is correct for the original request, but it does not protect episodes that air later. The optional
episode recovery worker closes that gap for monitored Sonarr series carrying the configured
`AVISTAZ_TAG`.

## Flow

1. Scan monitored, aired, missing episodes from the last `EPISODE_RECOVERY_LOOKBACK_DAYS`.
2. Limit the scan to Sonarr series carrying the AvistaZ tag.
3. Wait `EPISODE_RECOVERY_PUBLIC_GRACE_HOURS`, then trigger a targeted Sonarr `EpisodeSearch`.
4. If the exact episode is still missing after `EPISODE_RECOVERY_AVISTAZ_GRACE_HOURS`, search the
   AvistaZ Prowlarr indexer for the exact `SxxEyy`.
5. Only an exact, non-season-pack match at or above `EPISODE_RECOVERY_MIN_CONFIDENCE` is sent to
   rTorrent. The existing durable grab worker then transfers and imports it into Sonarr.

The worker uses a durable `episode_recovery` SQLite table, honors the existing daily AvistaZ grab
allowance, skips episodes already in the Sonarr queue or an active grab, and is disabled by default.

## Relationship to season-pack-first searching

This worker is deliberately episode-shaped: it exists for the *next* episode of a series you are
following, where no season pack can exist yet. It is the wrong tool for an old show with a large
hole in it — one AvistaZ download slot per episode is exactly the waste that
[season-pack-first searching](../README.md#season-pack-first-searching-old-shows-every-indexer)
prevents.

So when `SEASON_PACK_FIRST` is on, the worker stands down on any season that path owns (an old
show with at least `SEASON_PACK_MIN_MISSING` missing episodes, or an entirely missing season).
Those seasons are left to the season search, and on a metered tracker the two never race for the
same slots. A season that later drops below the pack threshold — one or two stragglers — resumes
episode-level recovery automatically.

## Configuration

```env
EPISODE_RECOVERY_ENABLED=false
EPISODE_RECOVERY_CHECK_MINUTES=30
EPISODE_RECOVERY_PUBLIC_GRACE_HOURS=6
EPISODE_RECOVERY_AVISTAZ_GRACE_HOURS=12
EPISODE_RECOVERY_LOOKBACK_DAYS=14
EPISODE_RECOVERY_MAX_PER_RUN=3
EPISODE_RECOVERY_MIN_CONFIDENCE=88
```

This feature requires the existing Sonarr, Prowlarr, AvistaZ, rTorrent, rclone staging, and direct
grab settings. Start with the feature disabled, verify the normal direct-grab pipeline, then enable
it with a conservative daily grab limit.
