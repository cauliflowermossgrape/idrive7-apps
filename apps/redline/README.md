# Redline

A full-screen rev display in the style of the G20 Live Cockpit (Sport). It shows a wide slanted
rev bar, digital rpm, a big gear, speed, oil and water temperatures, and 12 shift lights. Every
upshift is scored against your shift point. A cold-engine guard holds the shift point down until
the oil is warm. The main README's app table describes the screen itself.

This file is mostly about the **experimental** parts added on top. Each one is marked
*(experimental)* in Settings:

- [Head-up display](#head-up-display): the shift lights, rev bar, gear and temperatures on the HUD,
  next to BMW's own HUD content.
- [Shift cue](#shift-cue): shift lights that count you into the shift and flash early by your
  reaction time. The HUD and the screen share it.
- [Learning](#learning): the real rev limit, the best upshift rpm for each gear, and your reaction
  time, all learned from driving. The **Learned** page shows them, with resets.
- [Downshift cue](#downshift-cue): arrows by the gear while you brake, one for each gear you can
  drop without over-revving.

Tested on a 2021 330i G21 (B48, ZF 8HP, iDrive 7). It should work on other iDrive 7 G-series
cars with a HUD, but nobody has checked yet.

## Head-up display

### What you need

- **cluster-render**, installed from the MGU Store (Store page, *Cluster renderer*, from the
  `idrive-apps` source). It is the service that draws apps' layers on the cluster and the HUD.
  Redline works without it; the HUD then stays empty.
- A car with a HUD. iDrive 8 isn't supported.

### Setting it up

1. Settings → **Show on HUD (experimental)** → **Test pattern**. A full-scene pattern appears with
   the tach where it will sit, plus rulers and frames every 40 px. On a G21 only the inner
   (yellow, 120 px) frame is visible: about x 120–680, y 120–360 of the 800×480 scene. BMW's
   speed and limit sign sit along its bottom edge.
2. Use **HUD settings** → *Size* and *Position* to move the tach. The pattern follows as you go.
3. Set **Show on HUD** to **On**.

### What it shows

From left to right: the gear (P R N D or 1–8) with the downshift arrows under it; 12 round shift
lights over a slanted rev bar; and oil, water and gearbox temperatures. A small yellow mark
shows the shift point and a red one the redline.

Black is see-through on the HUD glass, so everything is drawn on black. Unlit lights and bar
segments can be faint or hidden (*Unlit segments*).

The temperatures sit to the right of x 150. That's because BMW draws its driver-assistance
graphic (lanes, steering wheel, ACC distance) under the left of the bar.

Temperature colours: blue is cold, yellow means the oil is still warming (under *Oil warm at*),
white is normal and red is hot. A reading with no data is left out.

### HUD settings (one row in Settings, shown while the HUD is on)

| Setting | Values | Notes |
|---|---|---|
| Size | 70–130 % | Scales about the top centre |
| Position left / right, up / down | px | Moves the layer only, so the change shows at once |
| Shows | tach, gear and temperatures / tach and gear / tach and temperatures / tach only | |
| Shift lights | GT3 (outside in, flash) / left to right / off | |
| Frame rate | 10 / 20 / 30 fps (20) | See [Performance](#performance) |
| Unlit segments | dim / hidden | |

### What it does with BMW's content

- BMW's speed, limit sign, navigation arrows and assistance graphics stay in their own HUD
  slots, which cluster-render never takes.
- When BMW shows a pop-up on the HUD (media, lists), cluster-render moves the tach aside. It
  comes back about 1.5 s after the pop-up goes. Redline pauses drawing in the meantime.
- If the cluster restarts twice within 10 s of the HUD being mapped, cluster-render's mapping
  guard turns the HUD off. The Learned page then says *HUD: off after display errors*. To turn
  it back on, run this over SSH as root:
  `/var/opt/cluster-render/current/cluster-render guard-reset`.

## Shift cue

The 12 lights are a **shift** light, not a rev scale:

- **Count-in.** The lights fill over about the last second before the shift. The rpm span comes
  from how fast the revs climb (800–2000 rpm), so the count takes about as long in 2nd as in 5th.
  In GT3 style the pairs light from both ends inwards: green, yellow, red.
- **Early flash.** All lights flash, by the clock at 5 Hz, early by your reaction time × the climb
  rate (at most 800 rpm), so that your shift lands on the shift point. *Shift lights early by*
  sets the reaction time; *Auto* learns it.
- **Ending the flash.**
  - A gear change ends it, and the next gear counts in afresh.
  - Without a gear signal, a drop of 12 % from the highest rpm while flashing ends it. An upshift
    drops 18 % or more on an 8-speed; a traction dip drops less.
  - Revs falling for 300 ms (a lift) also end it.
- **Lifting or holding.**
  - Lift before the shift point and the lights step back down one at a time.
  - Hold a steady rpm below the shift point and the count stays steady.
  - Hold past the shift point and the lights keep flashing.
- **Limiter.** Within 40 rpm of the redline, the bar, the lights and the gear all flash red.

The yellow mark is the shift point itself. The flash comes before it on purpose: in 1st, the revs
climb about 3000 rpm/s, so a 240 ms reaction means a flash about 700 rpm early.

## Learning

All of it is on by default and can be frozen with **Learning (experimental) → Learn from
driving**. Values learned before stay in use. Nothing is ever learned from the demo drive. The
**Learned** page (third tab) shows everything, each with a Reset that you press and then confirm.
On the software renderer, where the page has no buttons, the bar button *Reset learned* (pressed
twice within 5 s) resets them all.

### Redline (the real rev limit)

`limiter.js` watches for the plateau the engine makes on its limiter:

- in gear, moving and with warm oil;
- the rpm stays within a 200 rpm band, with no trend, for 500 ms;
- just before the plateau, the revs were climbing at 600 rpm/s or more. A limiter stops a climb
  dead; easing off to hold an rpm slows it first.

The first value needs **two** such plateaus within 100 rpm of each other. After that, only a
**higher** plateau changes it, for example after a tune. A pull that stops short never lowers it.
A frozen rpm reading (a stale signal) is ignored.

Which redline is used, first that has one: the *Redline* setting, then the learned limit, then the
engine profile (petrol 7000, diesel 5000).

### Shift points, per gear

`shiftmap.js` learns two things:

- **The full-load torque curve**, from the car's crankshaft torque signal. It's binned every
  250 rpm. Each bin is the highest value confirmed by 3 samples within 5 %, so part throttle and
  spikes don't count. Only torque readings less than 300 ms old are used.
- **Each gear's rpm per km/h**, from steady samples above 20 km/h (a running median of 50).

The best upshift from gear g is the first rpm at which the next gear gives at least 99 % of the
wheel torque you have now. If that never happens before the redline, the point is the redline.
The 99 % means a flat-power engine settles on the earliest equally good point.

The learned point is held 150 rpm under the redline, so a shift on it never looks like the
limiter. **Minimum shift point** sets a floor, and the cold guard still lowers it while the oil is
cold.

To fill the curve, do a few full-throttle pulls, some from low rpm (kickdowns in 2nd–4th), up to
the redline. Until a gear is known, its shift point is *redline − Shift point before redline*.
**Shift point → Redline minus the setting below** turns the per-gear points off.

### Reaction time

With *Shift lights early by* on **Auto**, each upshift after a flash you could see (HUD shown,
lights on) checks how late it came: (shift rpm − shift point) ÷ climb rate. The lead then moves
30 % of the way to what would have hit the point, within 0–600 ms. A shift that comes more than
700 ms after the revs started falling (you lifted first) is not used.

## Downshift cue

Cyan arrows under the HUD gear, and beside the gear on the screen, show how many gears (up to 3)
you can drop without the revs passing that gear's shift point less 300 rpm. The rpm after a
downshift is your speed × that gear's learned rpm per km/h, so the arrows appear once the gear
ratios are learned.

*Downshift cue*:

- **While slowing down** (default): under braking of 6 km/h per second or more. Off-throttle
  coasting doesn't count.
- **Always**.
- **Off**.

## Files and logs

Everything lives in the app's `data/` folder on the head unit
(`/var/opt/public/oap/oap_<uid>/data/`):

| File | What | Size | Written |
|---|---|---|---|
| `redline.log`, `redline.log.1` | the app's log, rotated at 256 KB | ≤ ~512 KB | on events, never per frame |
| `settings.json` | settings | small | when a setting changes |
| `limiter.json` | learned redline | < 50 B | when it rises |
| `shiftmap.json` | torque bins and gear ratios | ~0.5–10 KB | at most every 5 min while learning, at most once a minute when a shift point moves |
| `hudlead.json` | learned reaction time | < 50 B | when it moves |
| `engine.json` | detected engine type | tiny | once |

Learned files are written to a temp file and renamed, so a power cut can't corrupt them. On
load they are range-checked; a bad file is ignored and relearned.

To see what was learned, run this from a computer on the car's hotspot:

```sh
ssh root@172.16.222.97 "grep -h -E 'limiter|shiftmap|hud: |gearbox' /var/opt/public/oap/oap_*/data/redline*.log | tail -n 60"
```

Useful lines:

- `hud: target …`: what cluster-render reports (shown, parked behind BMW's content, disabled).
- `hud: rpm samples every N ms`: how often the car sends rpm.
- `limiter: learned …`
- `shiftmap: 3>4 at 5550`
- `hud: shift at … (N ms late), reaction lead now …`
- `gearbox: EGS 6000 = … C`

## For developers

| File | What |
|---|---|
| `main.js` | The app: the screen pages, settings, scoring, and the wiring of everything below |
| `hud.js` | The HUD layer (connect, draw, send), `shiftCue()` (shared with the screen), `drawHud()`, the test pattern |
| `limiter.js` | Learned rev limit |
| `shiftmap.js` | Learned torque curve, gear ratios, per-gear shift points |
| `gearbox.js` | Gearbox oil temperature (EGS `0x18` over read-only UDS 22, or SOME/IP BasicDataSet) |
| `cluster_render_client.js` | Vendored unchanged from robertnisipeanu/idrive-apps `native/cluster-render/js` (MPL-2.0) |

**Flow.** Car samples (about 10–20 a second) go to `main.js` `onSample`. From there they feed the
screen's shift cue, `limiter.feed`, and `shiftMap.feed` (with fresh torque). The HUD has its own
timer at the *Frame rate*. Each tick it reads `car.data()`, smooths the rpm between samples, runs
its own shift cue and draws. Upshifts detected in `main.js` go to `hud.upshift()` for the reaction
time.

**Rules.**

- **Node 8:** no `?.`, `??`, object spread, `Array.flat` or `Object.fromEntries`.
- **Never let an error escape** a timer, signal or render path: MainApp wipes an app's data the
  first time it exits unexpectedly, and uninstalls it the second time. Every HUD callback goes
  through `safe()`.
- **Two kinds of canvas.**
  - The tach and Learned pages draw on the kit's **Recorder** (`kit/runtime/record.js`), which has
    `quad` but no `convex` or `triangle`.
  - The HUD draws on a **Canvas** (`kit/runtime/canvas.js`). Its `.d` is straight-alpha RGBA,
    which is what cluster-render takes; wrap it in a Buffer before `cr.pixels`.
  - Use `blit` to composite, not `drawImage`: `drawImage` copies pixels without blending alpha.

**Performance (HUD).**

- No drawing while the target isn't showing: parked, waiting, unavailable or disabled. Keep
  drawing while it's idle or acquiring, because cluster-render only asks for the target once the
  layer has content.
- A frame whose inputs haven't changed is skipped.
- The static parts (unlit lights, dim track, red zone, labels) are drawn once per layout.
- Changes go out as up to three strips from a reused buffer: about 2–20 KB a frame. That is well
  inside cluster-render's upload budget (5500 KB/s, with up to half of it for the HUD), which is
  why 30 fps is affordable.

**Checking changes without a car.**

```sh
python kit/tools/build.py redline --preview-only
node kit/tools/preview.js dist/redline preview/redline wait=4 render BTN_PAGE render BTN_PAGE render --set hud=on
```

The preview forces demo data, so nothing is learned; seed `preview/redline/*.json` to see the
Learned page filled. The repo's own checks are in `.github/workflows/app-tests.yml`.
