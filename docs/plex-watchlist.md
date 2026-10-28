# Plex watchlist auto-requests

Seerr can request anything a member adds to their Plex watchlist. This is Seerr's own feature
(the "Plex Watchlist Sync" job), so the bot doesn't poll Plex or create these requests itself. It
handles them the same way it handles any request made in Seerr, plus a note saying where each
one came from.

## Turning it on

It takes two steps, so nobody is surprised:

1. **You grant it.** In Seerr, open **Users**, edit the member, and under permissions turn on
   **Auto-Request**, then **Auto-Request Movies** and/or **Auto-Request Series**. To offer it to
   everyone who joins later, set the same permissions under **Settings → Users → Default
   Permissions**.
2. **They switch it on.** The member opens their own Seerr profile, goes to **General**, and turns
   on **Auto-Request Movies** and/or **Auto-Request Series**.

Requirements and limits, from Seerr's documentation:

- The member must have signed in to Seerr with their Plex account at least once, and that Plex
  account must have access to your server. Local Seerr users can't use it.
- Only standard quality. 4K still has to be requested by hand.
- Titles already in the library aren't requested.
- Each member's Seerr request quotas still apply.
- Seerr checks watchlists on a schedule, so a new watchlist item can take a few minutes to show up.

## What happens next

A watchlist request is made as that member, so the usual approval rules apply:

- **Members with Auto-Approve** (two people today): the request goes straight through. The bot
  posts **Request Auto-Approved** in the requests channel, noting that it came from their Plex
  watchlist. The member gets one DM, **📋 Added From Your Plex Watchlist**, saying it's approved
  and on its way.
- **Everyone else:** the request waits for approval. The bot posts **New Request** with
  **Approve** and **Deny** buttons, noting that it came from their Plex watchlist. The member gets
  a DM, **📋 Added From Your Plex Watchlist**, saying it's waiting for an admin. After that they
  get the usual DMs when it's approved and when it's ready. **Approve all pending** in the
  dashboard's Operations tab clears a batch at once.

How the bot tells: Seerr's webhook doesn't mark watchlist requests, so for each new request it
didn't create itself, the bot reads the request back from Seerr and checks its `isAutoRequest`
flag. If that lookup fails, the request is treated as a normal one: no note, no watchlist DM.

To limit the volume from someone with a long watchlist, grant only **Auto-Request Movies** or only
**Auto-Request Series**, or lower their Seerr quota.
