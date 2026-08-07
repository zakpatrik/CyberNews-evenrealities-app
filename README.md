# CyberNews

Cybersecurity headline reader for the Even Realities G2. Merges four feeds into
one chronological list on the glasses: **The Hacker News**, **BleepingComputer**,
**Cybersecurity News** and **Dark Reading**.

Scroll the list on the temple touchpad, tap to read the summary, double-tap to go
back — and again to bring up the exit confirmation.

## Controls

| Gesture | List | Story | Exit confirmation |
|---|---|---|---|
| Scroll up/down | move selection | previous/next page | move selection |
| Tap | open story | next page, then back to list | activate choice |
| Double-tap | ask before exiting | back to list | cancel |

**There is no long-press.** `OsEventTypeList` exposes only click, scroll, and
double-click; the firmware reports no press duration and no down/up pair, so a
hold cannot be detected or synthesised. Double-tap is the only exit-ish gesture
available — which is precisely why exiting asks first, since double-tap is easy
to hit by accident while scrolling.

The confirmation is built from ordinary containers rather than
`shutDownPageContainer(1)`, whose native prompt gives no control over which
option starts selected. **"No" is listed first because the list widget opens on
index 0** — that is the whole mechanism behind it being the default. An event
whose `currentSelectItemIndex` is missing (protobuf omits zero) therefore also
resolves to "No", never to exit.

```
┌────────────────────────────────────────────────┐
│ CyberNews · 20 of 60 · 12 new                  │  header (text container)
│ ┌────────────────────────────────────────────┐ │
│ │ THN New Zapscape KVM Flaw Could Let Priv…  │ │  selected row
│ └────────────────────────────────────────────┘ │
│   BC  OpenAI rolls out a major ChatGPT upg…    │  list container,
│   CSN Shai-Hulud CHAINDROP Worm Backdoors …    │  capped at 20 rows
│   DR  The Coordination Gap: How Attackers …    │
└────────────────────────────────────────────────┘
                   576 × 288
```

## Architecture

```
GitHub Actions, hourly                ← ordinary runner IPs, all four feeds answer
  fetcher/build-feed.mjs
  fetch 4 RSS feeds → parse → merge → dedupe → feed.json → commit
        │
        ▼
raw.githubusercontent.com/<you>/<repo>/main/feed.json
        │
        ▼
Cloudflare Worker                      ← serves the app and caches the feed
  /            static app bundle (dist/ via [assets])
  /feed        the published JSON, filtered and edge-cached 15 min
  /health      liveness
  /diag        feed age + per-source status
        │
        ▼
G2 glasses (WebView on the phone)
```

**Why fetching is not in the Worker.** The app cannot fetch the feeds itself —
none of the four sites send CORS headers. But the Worker cannot either, because
two of them refuse requests from Cloudflare's network:

| Source | From a normal host | From a Cloudflare Worker |
|---|---|---|
| The Hacker News | 200 | 200 |
| Dark Reading | 200 | 200 |
| BleepingComputer | 200 | **403, error 1106** |
| CybersecurityNews | 200 | **202 → `/.well-known/sgcaptcha/`** |

Error 1106 is Cloudflare declining to proxy a Worker subrequest to another
Cloudflare-fronted zone; no combination of headers gets around it. Every
workaround was probed and rejected: `feeds.feedburner.com/BleepingComputer` is
the site's *YouTube channel* (last post 2020, no summaries), the CSN FeedBurner
mirror carries one item, public CORS proxies returned 521/522, and Google News
is rate-limited from Cloudflare and carries headlines with no summaries.

Splitting fetch from serve fixes it without hosting anything: the cron runs on
GitHub's infrastructure, the Worker stays a cache and a static host, and nothing
listens on any machine of yours.

Payload-wise this also turns ~380 kB of XML into ~36 kB of JSON. The published
page is public — a reader over public feeds, with no credentials in the bundle.

## Deploying

Two independent halves: the Worker goes to Cloudflare, the app goes to Even Hub.
Both need an interactive login, so neither can be fully scripted.

**0. Publish the feed from GitHub**

Push this directory as the root of a GitHub repo, then:

```bash
node fetcher/build-feed.mjs --out feed.json   # sanity-check locally first
```

In the repo: **Actions** → enable workflows → run **feed** manually once
(`workflow_dispatch`). It commits `feed.json` and prints a per-source table.
Watch that first run — it is what tells you whether GitHub's runners reach
BleepingComputer and CybersecurityNews. If a source fails there, the job keeps
its previous items rather than dropping it, and says so in the run summary.

Then set the raw URL in `worker/wrangler.toml`:

```toml
[vars]
FEED_SOURCE_URL = "https://raw.githubusercontent.com/<you>/<repo>/main/feed.json"
```

A private repo will not serve `raw.githubusercontent.com` without a token, so
either keep the repo public or publish `feed.json` somewhere else readable.

**1. Deploy the Worker**

On a machine with a browser:

```bash
npm run worker:install
cd worker && npx wrangler login
cd .. && npm run deploy
```

**On a headless or remote box, `wrangler login` does not work** — it starts a
callback listener on `localhost:8976` and opens a browser, and you have neither.
Use an API token instead:

1. Cloudflare dashboard → **Workers & Pages**, and register a `workers.dev`
   subdomain if you have not (the first deploy needs one to exist).
2. [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   → **Create Token** → template **Edit Cloudflare Workers**.
3. Deploy with the token inline, so it is never written to disk:

```bash
CLOUDFLARE_API_TOKEN=<token> npm run deploy
```

If the token can see more than one account, also pass
`CLOUDFLARE_ACCOUNT_ID=<id>`, or add `account_id` to `worker/wrangler.toml`.

The URL comes from `name` in `worker/wrangler.toml`, so it lands at
`https://cybernews-feed.<your-subdomain>.workers.dev`.

Validate the config without deploying — this needs no credentials at all:

```bash
npm run build && cd worker && npx wrangler deploy --dry-run
```

**2. Point the app at it**

```bash
npm run feed-url https://cybernews-feed.<your-subdomain>.workers.dev
```

This writes both places the URL has to appear and probes `/health`. Doing it by
hand is the classic way to break this: `.env` is inlined by Vite at **build**
time, while the `app.json` whitelist is enforced by the host at **runtime**. Set
only `.env` and you get a build that looks perfect and silently fetches nothing
on the glasses.

**3. Check it on real hardware before packaging**

The Worker serves the built app as well as the feed, so the QR can point
straight at it — no dev server, and nothing that needs your phone and your
machine on the same network:

```bash
npm run deploy                                          # build + deploy both
npx evenhub qr --url https://cybernews-feed.<your-subdomain>.workers.dev
```

The docs only use a LAN IP as their *example*; `evenhub qr --url` takes any URL
and has its own `--https` flag. Serving from one origin also means app and feed
are same-origin: one whitelist entry, no CORS surface.

The LAN route still works if you want hot reload, and is faster to iterate on:

```bash
npm run dev
npx evenhub qr --url http://<your-lan-ip>:5173
```

Either way, do check on hardware — everything here was verified in the
simulator, which re-implements the drawing logic rather than sharing firmware
code.

**4. Package and submit**

```bash
npm run build && npm run pack        # -> cybernews.ehpk
npx evenhub login -e you@example.com
npx evenhub pack app.json dist -c    # is the package_id still free?
```

Then upload `cybernews.ehpk` through the dev portal — the CLI has no publish
command, only `login`, `init`, `pack` and `qr`.

Bump `version` in `app.json` for every submission. `package_id` must stay
lowercase alphanumeric with at least two dot-separated segments and no hyphens.

## Local development without deploying

The Worker reads a published `feed.json`, so serve one locally and point it
there — no GitHub round-trip needed to iterate:

```bash
npm run feed:install && npm run feed:build       # writes ./feed.json
python3 -m http.server 8791 &                    # serves it at /feed.json

cd worker && npx wrangler dev --port 8787 \
  --var FEED_SOURCE_URL:http://127.0.0.1:8791/feed.json

npm run feed-url http://<your-lan-ip>:8787       # or http://localhost:8787
```

`npm run feed:build` also works as a standalone check that the four sources are
reachable from wherever you are running it.

Remember to point the app back at the deployed Worker before packaging — a
`.ehpk` built against `localhost` installs fine and never loads a story.

## Not done yet

- **App icon.** Even Hub wants a 24×24 monochrome icon, which this repo does not
  have. It is not an `app.json` field — it is uploaded in the dev portal.
  [g2-icon-studio](https://github.com/naotake/g2-icon-studio) makes them.
- **Locked-phone behaviour.** Reviewers test it, and this app has not been. It
  stops its refresh timer on `FOREGROUND_EXIT_EVENT`, which is the relevant
  hook, but that path has only been exercised synthetically.

## Tests

Both need the Worker running (`npm run worker:dev`).

```bash
npm run verify   # firmware byte budgets, against live feed data
npm run e2e      # interaction model, with a faked SDK bridge
```

`verify` matters because the G2 does not degrade gracefully when a container
exceeds its limits — it fails to render — and the strings come from four
third-party feeds nobody here controls.

`e2e` checks that the right containers get built and that taps move between
views. It does not check pixels — for that, run the simulator, which needs
WebKitGTK (`apt install libwebkit2gtk-4.1-0` on Debian/Ubuntu) and can be driven
over HTTP:

```bash
evenhub-simulator http://localhost:5173 --automation-port 9898
curl -X POST localhost:9898/api/input -d '{"action":"down"}'   # up|down|click|double_click
curl localhost:9898/api/screenshot/glasses -o shot.png         # 576x288 PNG
curl localhost:9898/api/console                                # console + failed fetches
```

Every view and transition here was verified that way. **Layout has not been
checked on real hardware** — the simulator re-implements the drawing logic
rather than sharing firmware code, and its own README warns that font rendering
and list scroll positioning can differ.

## Refresh pacing

The feed changes once an hour, when the workflow publishes. Requests in between
cannot return anything new, and on glasses a needless request is radio time is
battery. So `src/schedule.ts` does two things:

- **Skip.** A fetch is refused if the last one was under 10 minutes ago.
  Opening the app ten times an hour costs one request, not ten.
- **Aim.** The next wake-up targets just past the next expected publish. Feed 10
  minutes old → look again in ~50, not in 5. Floored at 10 min, capped at 60,
  plus up to 2 min of jitter so devices do not all wake on the same second.

Failures back off from 2 min, doubling to 60. Backgrounding cancels the timer
outright (`FOREGROUND_EXIT_EVENT`), so a pocketed phone makes no requests.

The skip test is keyed on **when we last fetched**, not on when the feed was
last published. Those differ, and using the publish stamp gets it wrong: a
20-minute-old feed reads as stale, so every reopen refetches, even though
nothing new exists until the next hourly publish. The e2e caught exactly that.

`nextRefreshDelay` and `isFreshEnough` are pure and covered by `npm run verify`,
including clock skew putting the publish stamp in the future.

## Limits

Two different kinds, and conflating them causes bugs. Both are enforced in
`src/format.ts` byte-wise — feed titles are full of multi-byte punctuation, so
character counts understate them.

**Hard firmware caps.** Exceed one and the container fails to render outright.

| Limit | Value | Source |
|---|---|---|
| List items | 20 | simulator changelog v0.7.3 |
| Bytes per list item | 63 | simulator changelog v0.7.3 |
| Bytes per text container | 999 | simulator changelog v0.7.1 |
| Containers per page | 4 image + 8 other | SDK `CreateStartUpPageContainer` |
| Canvas | 576×288, 4-bit greyscale | hardware |

**Rendered-size budgets.** Measured in the simulator. Text that is perfectly
legal still wraps or clips once it exceeds 576×288, which quietly breaks the
layout, so these sit well below the firmware caps.

| Budget | Value | Why |
|---|---|---|
| `LIST_ITEM_MAX_BYTES` | 56 | 58 still fits one line, 63 wraps to two and misaligns the list |
| `DETAIL_MAX_BYTES` | 500 | only ~10 lines fit in 288px; the rest is silently clipped |
| `DETAIL_TITLE_MAX_BYTES` | 110 | keeps the headline to at most two lines |

The 20-row cap is why the header reads `20 of 60` — the list is deliberately
honest about being truncated. The detail pager rides on the source line
(`The Hacker News · 15h · 1/2`) because a pager under the body cost two lines
and fell off the bottom of the canvas.

## Layout

| File | Purpose |
|---|---|
| `src/main.ts` | State machine: bootstrap, refresh, event routing, view switching |
| `src/views.ts` | Container layouts for the list, detail and confirmation views |
| `src/format.ts` | Byte-aware truncation and pagination; pure, so it is testable |
| `src/feed.ts` | Worker client, response validation, unread count |
| `src/config.ts` | Firmware limits, geometry, container IDs, tunables |
| `src/schedule.ts` | Refresh pacing; pure, so the battery logic is testable |
| `fetcher/parse.mjs` | RSS fetch, parse, normalise, dedupe — runs in CI |
| `fetcher/build-feed.mjs` | Writes feed.json, carries a failed source's last items |
| `worker/src/index.ts` | Serves the app and the published feed; no parsing |
| `.github/workflows/feed.yml` | The hourly cron |

## Known gaps

- Verified in the simulator, not on hardware. The rendered-size budgets above
  are calibrated to the simulator's font metrics; if the glasses render slightly
  wider, list rows will wrap. `LIST_ITEM_MAX_BYTES` is the dial to turn.
- `TextContainerUpgrade.contentLength` is set to a byte count. The SDK does not
  document the unit; every other length in the API is bytes.
- No offline cache. A failed refresh keeps the last list on screen but survives
  neither an app restart nor a cold start without network.
- Only the newest 20 stories are reachable. Source filtering (`?src=THN,BC`) is
  already supported by the Worker but not yet surfaced in the UI.
