# rTorrent control API

The Director can control the configured seedbox through the existing authenticated bot API.
No LiteFlow template, new public seedbox port or arbitrary XML-RPC proxy is needed.
Only one rTorrent endpoint is configured; this uses the same seedbox as the bot's grab pipeline.
Do not replace an existing provider URL unless you intend to switch that pipeline too.

## Setup

1. Set `RTORRENT_URL=https://<server>.myseedbox.site/RPC2` for EvoSeedbox.
2. Set `RTORRENT_USERNAME` and `RTORRENT_PASSWORD` to the ruTorrent credentials in your
   deployment's private environment. Separate credentials take precedence over URL credentials.
   Existing URLs with embedded credentials still work. Use HTTPS; redirects are rejected.
3. Restart the bot. Create a dashboard agent token with `read` for inspection and `write`
   for torrent controls. The existing legacy agent token also works. Never give the Director
   the seedbox credentials themselves.
4. Check `GET /api/v1/rtorrent/torrents` with `Authorization: Bearer <agent token>`.

Evo documents this endpoint and authentication at
https://evoseedbox.com/wiki/dashboarr-rtorrent-rutorrent/ .

## Endpoints

All paths below are relative to `/api/v1/rtorrent` and require bearer authentication.

| Method | Path | Scope | Body / behavior |
| --- | --- | --- | --- |
| GET | `/torrents` | read | `search`, `offset` and `limit` query parameters; limit 1–100, default 50 |
| GET | `/torrents/:hash` | read | One torrent; 404 if absent |
| POST | `/torrents` | write | `{"magnet":"magnet:?xt=urn:btih:...","label":"sonarr"}` |
| POST | `/torrents/:hash/start` | write | `{}`; starts torrent |
| POST | `/torrents/:hash/resume` | write | `{}`; alias for start |
| POST | `/torrents/:hash/stop` | write | `{}`; stops torrent |
| POST | `/torrents/:hash/pause` | write | `{}`; alias for stop |
| POST | `/torrents/:hash/recheck` | write | `{}`; requests hash check |
| POST | `/torrents/:hash/set-label` | write | `{"label":"sonarr"}`; empty string clears label |

Hashes are 40 hexadecimal characters. Labels accept up to 64 letters, numbers, spaces, dots,
underscores and hyphens. Magnet adds accept one v1 BTIH (hex or base32), display name and tracker
parameters; URL/file downloads, webseeds and exact-source parameters are rejected. New magnets
start in rTorrent's default directory and are not automatically added to the bot's import job table.
An add response confirms RPC acceptance, not completed metadata retrieval or successful download.
A timeout has an uncertain outcome: inspect state before retrying any mutation.

List responses contain `total`, `offset`, `limit`, and `torrents`. Torrent fields are the existing
client projection: `hash`, `name`, `complete`, `label`, `basePath`, `sizeBytes`, `doneBytes`,
`downRate`, `ratioPermille`. The ratio is in thousandths, so 1420 means 1.42. Pagination limits the
HTTP response; rTorrent's main view is fetched for each request. Upstream responses are capped at
8 MiB. Existing per-token read/write rate limits apply. Mutations audit the token label and action;
credentials, magnet tracker passkeys, and raw RPC failures are excluded from these route logs.
HTTP errors: 400 validation, 401 authentication, 403 scope, 404 missing torrent/route, 429 rate
limit, 502 upstream error, 503 unconfigured integration.

## Sonarr matching and safety boundaries

A label changes the rTorrent category. It does **not** identify a series or episode, guarantee
Sonarr sees the download, or import files. Use the existing `/rtorrent adopt` search/picker and
staging/manual import workflow (also available through the scoped Discord bridge) to resolve
mismatches. This API deliberately does not claim `sonarrMatched` or an `approve-tv` result from a
label change. Configure Sonarr's download-client category and remote path mapping separately.

These new routes cannot erase torrents, delete data, move files, change global settings, or
execute arbitrary RPC methods. A future destructive API needs a separate human approval workflow;
a caller-supplied `approved: true` is not approval. This limitation concerns the new rTorrent routes:
existing broad Discord grants and other bot automations retain their existing behavior.

LiteFlow finished-torrent notifications are not part of this implementation. Poll the read endpoint
until a verified LiteFlow export schema and authenticated event receiver are added. No unverified
importable template is supplied.
