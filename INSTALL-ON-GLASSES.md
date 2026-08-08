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

| Gesture | List | Story |
|---|---|---|
| Scroll up/down | move selection | previous/next page |
| Tap | open story, or turn the page | next page, then back to list |
| Double-tap | system exit prompt | back to list |

The list pages. The firmware renders at most 20 rows, so the last one is
`>> Older` — tap it for the next 19 stories, and again until it wraps back to
the newest. The header says where you are: `CyberNews · 2/5 of 80`.

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

The glasses do not report a blocked source, because there is nothing to do
about it and nothing goes missing from the list. If it stays blocked, the age
in the header stops moving — that is the symptom worth noticing. The detail is
on the companion screen, in the console and at `/diag`.

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

## App icon

Even Hub wants a 24x24 monochrome icon, uploaded in the dev portal — it is not
an `app.json` field and does not travel in the `.ehpk`.

<img src="docs/app-icon-24-preview.png" alt="CyberNews app icon" width="120">

`docs/app-icon-24.png` is the file to upload. A shield holding three lines of
text; the last line is short, which is what reads as a paragraph rather than as
an "=" sign.

It is drawn in code, not exported from an editor, so the constraints are
checked rather than hoped for:

```bash
npm run icon
```

The generator asserts all four rules and exits non-zero if a tweak breaks one —
ink coverage 25.2% (the limit is 12-55%), no isolated pixels, nothing inside the
2px margin, and greyscale only.

---

## Submission assets

| Asset | File | Notes |
|---|---|---|
| Icon | `docs/app-icon-24.png` | 24x24, uploaded in the portal |
| Screenshots | `docs/screenshots/*.png` | 576x288, straight from the device render |

Screenshots have to match what the app actually renders, so these are captures
from the current simulator — **green on black, unaltered**.

**Do not convert them to greyscale.** An earlier submission was rejected for
exactly that. The monochrome rule covers the icon and background artwork, not
screenshots: a screenshot has to be accurate, and the display is green.

The only processing applied is flattening the transparent background onto
black. The simulator's framebuffer is pure green (R=0, G=255, B=0) with the
artwork carried entirely in the alpha channel, so the background arrives as a
transparent hole rather than as the black the wearer sees. Compositing changes
no visible pixel:

```python
im = Image.open(shot).convert('RGBA')
bg = Image.new('RGBA', im.size, (0, 0, 0, 255))
Image.alpha_composite(bg, im).convert('RGB').save(out)
```

---

## Limits of sideloading

A sideloaded app **dies the moment the phone locks** — the WebView is suspended.
That is fine for checking layout and interaction, but it cannot validate the
locked-phone behaviour that Even's reviewers test. For that you need a private
or beta build from the dev portal, which is required before submission anyway.
