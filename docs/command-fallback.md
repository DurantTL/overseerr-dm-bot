# Command fallback — rescuing typed commands

Members rarely mistype a slash command (Discord's autocomplete prevents most of
that). What actually happens: someone types what they *meant* as a plain
message — `/adpot bleach` sent as text (no such command exists, so Discord
posts it as a normal message), `rtorrent adopt bleach` with no slash, or an old
command name from memory. Without the fallback, the message just sits there.

The fallback (`src/command-fallback.js`) watches configured channels, resolves
the text against the live slash-command catalog, and either runs the command or
offers a one-tap confirmation showing the corrected command — so the member
gets what they asked for and learns the real command for next time.

## How a message is resolved

1. **Exact parse** — the text already is a valid invocation, just typed.
2. **Fuzzy parse** — edit-distance matching on command and subcommand names,
   then named (`search=bleach`, `--target sonarr`) and positional argument
   assembly. A trailing string option absorbs the rest of the line, so
   `rtorrent adopt bleach thousand year` is one search. Every candidate is
   gated by the same `validateExecInput` the [Agent API](agent-api.md) bridge
   uses — an invocation shape the real command would reject is never dispatched.
3. **LLM parse** (optional) — if configured, an OpenAI-compatible chat endpoint
   receives the message and a catalog summary and returns structured JSON. Its
   confidence is clamped (max 0.9), so an LLM-mapped command **always** requires
   a human tap, even for auto-run-listed commands.

## Safety model

- The dispatched interaction is backed by the **real message**: real author,
  real member permissions. Nobody can fallback-run something their own
  permissions wouldn't let them slash-run.
- A command's **admin-only setting** (`default_member_permissions`) is checked
  by the fallback itself, before offering and again before running. Discord
  only applies it in its own slash picker, so without this check an admin-only
  command whose handler doesn't re-check (such as `/staged`) would be open to
  anyone who typed its name. To a member who can't use a command, it isn't a
  command at all: no offer, no hint, no auto-run.
- **Credential commands** (the `CREDENTIAL_ACTIONS` register in
  `src/discord-exec.js`) are never run from text — the member is told to use
  the real slash command.
- Only an **exact** textual parse of a command on the auto-run list executes
  without confirmation. Everything else needs the original author (or an admin)
  to press **Run it** within 60 seconds.
- Every resolution, confirmation, dismissal, and cleanup is written to the
  audit log as `command_fallback` / `command_fallback_cleanup`.
- Handlers that would open a modal fail with a message telling the member to
  run the real slash command.
- **Private replies stay private.** A reply the handler marks ephemeral (for
  example `/me` with the member's Plex email, or `/downloads` with their links)
  goes to the author's DMs, with a one-line "sent you a DM" pointer in the
  channel. If their DMs are closed, the command fails and tells them to use the
  real slash command. A private reply is never posted in the channel.

## Strict-channel cleanup

In channels listed in `cmdfb_strict_channels`, a message that is not a command
attempt is chatter in a commands-only channel:

- `react` — a 👀 reaction plus a throttled pointer message (at most one per
  channel per 10 minutes, self-deleting after 20 seconds).
- `delete` — the author is DM'd an exact copy of their message first, then the
  original is deleted. If the DM fails, it degrades to `react`.
- Admins, pinned messages, bot mentions, and messages with attachments are
  always exempt from deletion (a delete must never destroy the only copy of a
  file); attachments get `react` treatment instead.

## Configuration

Runtime settings (app_settings, same store as the media panel):

| Key | Meaning | Default |
| --- | --- | --- |
| `cmdfb_enabled` | `1` enables the feature | off |
| `cmdfb_channels` | Comma-separated channel IDs to watch | none |
| `cmdfb_strict_channels` | Channels where cleanup applies (also list them in `cmdfb_channels`) | none |
| `cmdfb_cleanup` | `off` \| `react` \| `delete` | `off` |
| `cmdfb_autorun` | Comma-separated command names safe to run from an exact typed parse | none |

LLM tier (environment variables — the key is a credential, so it does not live
in app_settings):

| Variable | Meaning |
| --- | --- |
| `COMMAND_FALLBACK_LLM_URL` | Full chat-completions URL of an OpenAI-compatible API (hosted or local) |
| `COMMAND_FALLBACK_LLM_API_KEY` | Bearer key; optional for local models |
| `COMMAND_FALLBACK_LLM_MODEL` | Model name to request |

## Suggested rollout

1. Set `cmdfb_enabled=1` and `cmdfb_channels` to the requests channel only;
   leave cleanup `off` and the auto-run list empty. Everything arrives as a
   confirmation offer.
2. After a week, check the audit log for the offers members actually confirm —
   those are the commands to consider for `cmdfb_autorun`, and the typos worth
   turning into documentation.
3. Turn on strict cleanup (`react` first) only in channels that are genuinely
   commands-only.
