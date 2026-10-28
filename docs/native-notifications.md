# Native app notifications (failures and health only)

The media apps can post to Discord themselves. This sets them up so each one only speaks up when
something is wrong, using each app's own notification settings. Nothing new runs inside the bot.

| App | What it sends | How it is set |
| --- | --- | --- |
| Sonarr, Radarr, Radarr 4K, Prowlarr | Health issues (warnings included), health restored, imports needing manual interaction. Every other event is off. | `scripts/native-notifications.js` |
| Seerr | Failed requests, and issues (created, commented, resolved, reopened). Pending is left to the bot, which already posts it; approved and available are off. | `scripts/native-notifications.js` |
| Tautulli | Plex down and back up (Tautulli's own connection to Plex), and Plex update available. | `scripts/native-notifications.js` |
| Scrutiny | SMART failures. | `scrutiny.yaml`, below |

## Sonarr, Radarr, Prowlarr, Seerr and Tautulli

1. In Discord, create a webhook in the channel these alerts should land in.
2. Add it to the bot's stack as `NATIVE_ALERTS_DISCORD_WEBHOOK` and redeploy. The webhook URL
   carries Discord's token, so treat it like a password; the script never prints it.
3. Preview, from inside the bot container:

   ```sh
   docker exec -it <bot-container> node scripts/native-notifications.js
   ```

   It reads each configured app and lists what it would do:

   ```text
   + Sonarr: add Discord connection "Plex Director: failures & health": health issues, health restored, imports needing manual interaction (warnings included); every other event off
   = Radarr: "Plex Director: failures & health" already sends health issues, health restored, imports needing manual interaction only
   ~ Seerr: Discord agent types → failed + issues; stops: media pending, media approved, media available (webhook and on/off unchanged)
   + Tautulli: add Discord notifier "Plex Director: failures & health": Plex down (internal), Plex back up (internal), Plex update available
   ```

   `+` creates, `~` updates, `=` is already right, `-` is skipped (with the reason), `!` could not be read.

4. Apply what the preview listed:

   ```sh
   docker exec -it <bot-container> node scripts/native-notifications.js --apply
   ```

Running it again is safe: anything already right is left alone.

What it will and won't touch:

- In Sonarr, Radarr, Prowlarr and Tautulli it only creates or edits the one connection named
  **Plex Director: failures & health**. Your other connections and notifiers are never changed.
- Seerr has a single Discord agent, and it is also what pings members about their requests using
  the Discord IDs the bot stores. The script only changes which notification types it sends. It
  keeps the agent's webhook and on/off state, and skips Seerr if the agent is off.
- Some Sonarr and Radarr versions hide the stored webhook (`********`). On those, a change that is
  only the webhook can't be detected; edit it in the app's Connect settings instead.

## Scrutiny

Scrutiny has no settings API, so add the webhook to its `scrutiny.yaml` (in Scrutiny's config
folder) under `notify.urls`, using Shoutrrr's Discord form. A webhook URL
`https://discord.com/api/webhooks/<id>/<token>` becomes `discord://<token>@<id>`:

```yaml
notify:
  urls:
    - "discord://<token>@<id>"
```

Restart Scrutiny, then send a test notification:

```sh
curl -X POST http://<scrutiny-host>:8080/api/health/notify
```

To get failures only, set the notification level to **Fail** in Scrutiny's dashboard settings.
