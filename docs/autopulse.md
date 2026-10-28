# Autopulse: refresh only the imported item in Plex

When Sonarr or Radarr imports something, Plex normally finds it on its next library scan. Autopulse
takes the *arr's import webhook and asks Plex to refresh just that item, so new episodes and movies
show up right away without a library-wide scan.

- **Item-only:** Autopulse finds the matching item in Plex and refreshes only that item.
- **Non-destructive:** the *arrs only call it on import, upgrade and rename. Delete events stay off,
  and nothing here empties the Plex trash or touches files. It doesn't mount the media at all.
- **No approval step:** it runs on every import.

Nothing in this repo deploys it. Three steps, in order:

## 1. Run Autopulse

The stack is in [`deploy/autopulse/`](../deploy/autopulse/docker-compose.yml). On the Docker host:

1. Copy `deploy/autopulse/` to where your stacks live.
2. Copy `config.example.yaml` to `config.yaml` and put your Plex token in it. `config.yaml` is
   git-ignored; keep it that way.
3. If the *arrs see the library under a different path than Plex does, add the `rewrite` shown in
   the example to the Plex target.
4. Set `AUTOPULSE_PASSWORD` (and `AUTOPULSE_USERNAME` if not `admin`) for the stack, in Portainer's
   stack environment, then deploy. Put it on the same Docker network as Plex and the *arrs.

Autopulse listens on port 2875. Its web UI is at `/ui/`.

## 2. Point the *arrs at it

Add the same three values to the bot's stack and redeploy the bot:

```env
AUTOPULSE_URL=http://autopulse:2875
AUTOPULSE_USERNAME=admin
AUTOPULSE_PASSWORD=...
```

Then preview and apply with the script from [native-notifications.md](native-notifications.md):

```sh
docker exec -it <bot-container> node scripts/native-notifications.js
docker exec -it <bot-container> node scripts/native-notifications.js --apply
```

With `AUTOPULSE_URL` set, it adds one Webhook connection named **Autopulse: refresh imported item**
to Sonarr, Radarr and Radarr 4K. Sonarr calls `/triggers/sonarr`; both Radarrs call
`/triggers/radarr`. It's a POST with Autopulse's username and password, on import, upgrade and
rename only. Other connections are never touched. The password is never printed.

## 3. Check it

Import something (or use Sonarr/Radarr's **Test** button on the new connection) and watch
Autopulse's UI: the event should arrive and go to Plex. If Plex can't find the path, the target
needs a `rewrite`.
