# Getting CyberNews onto the G2

Two ways in. **Sideloading** takes a few minutes and is what you want right now.
**Packaging** is the route to a real installed app, and you will need it before
submission regardless — see [README](README.md#4-package-and-submit).

Nothing has to run on your machine for either. The app and its feed are both
served from the Worker at
`https://cybernews-feed.mail-40f.workers.dev`.

---

## Sideload

### 1. Before you start

- **Glasses paired** in the Even Realities app: Devices → Add device → Even G2.
- **Firmware updated.** Take the update immediately after pairing — the Even
  docs single this out, saying most connection failures come from stale
  firmware.
- The **same account** on the phone and on the web hub.

### 2. Unlock the developer section

There is no Developer Mode toggle. It appears once you have signed in on the web:

1. Sign in at [hub.evenrealities.com/login](https://hub.evenrealities.com/login).
2. **Force-quit** the Even Realities app on the phone — not just background it —
   and reopen it.
3. Open the **Even Hub** tab. A developer section is now in the top right, with
   a **Scan QR** button.

If the button is not there, the sign-in and the restart did not both happen.

### 3. Scan

Tap **Scan QR** and point the phone at this:

<img src="docs/qr-sideload.png" alt="Sideload QR for CyberNews" width="280">

It encodes `https://cybernews-feed.mail-40f.workers.dev` — nothing else. If your
markdown viewer will not show the image, open `docs/qr-sideload.png` directly,
or generate the same code in your own terminal:

```bash
npx evenhub qr --url https://cybernews-feed.mail-40f.workers.dev
```

The glasses should render the app within about a second.

### 4. What you should see

```
CyberNews · 20 of 60 · 12 new
┌──────────────────────────────────────────┐
│ THN New Zapscape KVM Flaw Could Let Pri… │   ← selected
└──────────────────────────────────────────┘
  BC  OpenAI rolls out a major ChatGPT up…
  CSN Shai-Hulud CHAINDROP Worm Backdoors…
  TR  Ransomware gang leaks negotiation logs…
```

| Gesture | List | Story | Exit confirmation |
|---|---|---|---|
| Scroll up/down | move selection | previous/next page | move selection |
| Tap | open story | next page, then back to list | activate choice |
| Double-tap | ask before exiting | back to list | cancel |

`20 of 60` is not a bug: the firmware caps a list at 20 rows, and the header is
deliberately honest that the feed holds more.

Opening a story gives you the **whole article**, not the RSS teaser — typically
15–20 pages, up to 47. The pager sits on the source line (`Cybersecurity News ·
24m · 4/18`). Scrolling turns pages as well as tapping, which is easier on a
long one.

If a source ever blocks extraction, that story shows `· summary` on the same
line and you get the RSS teaser — the app says so rather than pretending.

The bodies download once per refresh, so opening a story is instant and works
with no signal.

---

## Please check these three things

Everything else was verified in the simulator, which **re-implements** the
drawing code rather than sharing it with the firmware — its own README warns
that font rendering and list scrolling can differ. These three numbers are
calibrated against the simulator's metrics and are the ones most likely to be
slightly off on real hardware. All three live in `src/config.ts`.

| What to look for | If it is wrong | Fix |
|---|---|---|
| Do list rows wrap onto a second line, throwing off the spacing? | Glasses render wider than the simulator | `LIST_ITEM_MAX_BYTES` 56 → 52 |
| Is the last line of a story summary cut off at the bottom edge? | Fewer lines fit than measured | `DETAIL_MAX_BYTES` 500 → 460 |
| Does the header crowd the list, or leave a gap? | Header band mis-sized | `HEADER_H` 34 |

After changing any of them:

```bash
npm run verify        # re-checks the budgets against live feed data
npm run deploy        # build + push to the Worker
```

Then reload on the glasses — the QR does not change, so just scan again.

---

## If something looks wrong

**Blank display after scanning.** The app never got to render. Check the phone
is on a network, and that `https://cybernews-feed.mail-40f.workers.dev` loads in
the phone's browser.

**"CyberNews · no stories".** The app ran but the feed request failed. Check
`/diag`:

```bash
curl https://cybernews-feed.mail-40f.workers.dev/diag
```

`stale: true` means the hourly GitHub Actions workflow has stopped publishing —
look at the Actions tab. A `sources` entry with `ok: false` means one site
blocked that run; the fetcher keeps its previous stories, so the list stays
populated but that source ages.

**"2 src down" in the header.** One or more feeds failed on the last publish and
had nothing to carry over. It is reported rather than hidden on purpose.

**Rows all from one source.** Not a fault. The list is strictly newest-first
across all four, and one site can genuinely dominate a quiet hour.

---

## Regenerating the QR

Only needed if the Worker URL changes:

```bash
npm run feed-url https://cybernews-feed.<new>.workers.dev
npm run qr:img        # rewrites docs/qr-sideload.png from .env
npm run deploy
```

`npm run qr:img` reads `VITE_FEED_URL` from `.env` and strips the `/feed` path,
so the QR always points at wherever the app is actually served from.

---

## Limits of sideloading

A sideloaded app **dies the moment the phone locks** — the WebView is suspended.
That is fine for checking layout and interaction, but it cannot validate the
locked-phone behaviour that Even's reviewers test. For that you need a private
or beta build from the dev portal, which is required before submission anyway.
