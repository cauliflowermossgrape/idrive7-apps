# Redline

A full-screen rev display in the style of the G20 Live Cockpit (Sport). It shows a wide slanted
rev bar, digital rpm, a big gear, speed, oil and water temperatures, and 12 shift lights. Upshifts
made by hand near your shift point are scored against it; everyday shifts well below it show as
CRUISE and the gearbox's own shifts (D / S) as AUTO, left out of the score. A cold-engine guard holds the shift point down until
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

The HUD output is by [@biscotit](https://github.com/biscotit).

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
2. Use **HUD position and size** → *Size* and *Position* to move the tach. The pattern follows as you go.
3. Set **Show on HUD** to **On**.

### With Cluster functions

Cluster functions (the HUD map, turn signals and gear) stands on the HUD whenever it is on. Turning
Redline's HUD on takes the HUD over: Cluster functions gives way, except while Redline's tach is hidden.

In this fork *In Comfort / Eco Pro* is *Don't show* by default: Redline's HUD shows only in Sport (and
XtraBoost); in Comfort, Eco Pro, Adaptive and a plug-in hybrid's Hybrid and Electric it is hidden, and Cluster
functions has the HUD. A drive starts in Comfort, so it starts with Cluster functions, and Sport brings Redline's
tach up. *Give the HUD back to Cluster functions at switch-off* (on by default here) matters only when Redline
shows in Comfort too: then Redline's *Show on HUD* goes back to *Off* when the car is switched off or the head unit
starts again; turned off, Redline's HUD stays on from drive to drive.
Without Cluster functions installed, Redline's HUD stays on either way.
Both apps keep their state in `/dev/shm/mgu-hud` (`kit/runtime/hud_claim.js`), cleared at each head-unit start;
where it cannot be written, nothing is handed back. Cluster functions' side: TheoneLT83/Cluster-apps
`apps/robertn_waze_cluster/app/main.js` (`HudClaim.others`, `HudClaim.standing`, app id `robertn_waze_cluster`).

### What it shows

**Layouts** (*Layout*):

- **Standard:** the gear (P R N D or 1–8) with the downshift arrows under it; 12 round shift
  lights over a slanted rev bar; and a readouts row under the bar. A small yellow mark shows the
  shift point, a red one the redline, and a thin line where the revs peaked (*Peak marker*,
  dropping back after Redline's *Peak hold*).
- **Minimal:** the gear and larger shift lights only.
- **Split wings:** the gear in the centre, with 6 lights on each side filling in towards it and
  the bar underneath.
- **80s digital dash:** square lights, an LCD-style bar graph of 40 segments, and 7-segment digits
  for the gear and rpm.
- **VFD glow:** the same layout as a teal vacuum-fluorescent display, with unlit segments always
  faintly visible. It uses its own colours whatever *Colours* is set to.
- **Vector arcade:** the standard layout drawn in outlines only: rings, outlined segments and an
  outlined 7-segment gear.

Three layouts after BMW M's own head-up displays, in their colours (*Colours* doesn't change them):

- **Arc** (after the F80 / F82 M3 and M4): 8 curved shift lights (6 amber, 2 red; *Shift light
  style* Race or one colour uses those instead) over a curved band with a white rim and a tick per
  1000 rpm, ending in a yellow then red zone; the gear big under it. Readouts: the first beside the
  gear, two more at the far right, a fourth high on the left.
- **Ramp** (after the G80 / G82 M3 and M4): the band climbs from the bottom left, then runs flat
  along the top in slanted fields, with a 0–8 scale under it. The fields fill warm white, turn
  yellow as the shift nears and red at it; a red strip marks the redline. The gear sits over a line
  with the first readout under it (where the car shows the speed) and the others listed on the right.
- **Dial** (after the E60 M5): a ¾ dial round the gear: yellow-green, then an orange advance
  warning field (the last 1000 rpm before the redline), then red. The gear and readouts are in the
  dial's orange; the first readout bottom right (where the car shows the speed).

*Shift light style* (Settings) works on all three as on the other layouts: M is the cars' own colours,
Race counts in green then red and flashes blue, one colour counts in white. With the HUD's *Shift
lights* off they don't count in or flash for the shift (the limiter still flashes); GT3 and left to
right make no difference here: Arc fills left to right like the F80, Ramp and Dial along their band.
On Ramp and Dial the band is the shift lights too, so it stays with *Rev bar* off.

On all three the shift grade takes the first readout's place; with *Burst* a ring grows from the gear
(or the dial) and the lit band flashes the grade's colour. The whole band flashes red at the shift and
on the limiter, as in the cars.

**HUD drawing: a picture, not a shader.** The HUD is a 400x130 picture sent to cluster-render, only the
part that changed and only when it changes. Drawing the moving parts with a shader (a cluster-render effect
layer) was tried in 1.16 and left out, because of where the shader runs:

- The HUD is drawn by the **instrument cluster**, not the head unit. cluster-render hands it the HUD's
  content, shaders included, and the cluster's own graphics chip runs them.
- A shader for every layout (the lights, bar, digits and bands, with arrays of up to 40 colours and
  loops of up to 80 steps a pixel) **restarted the instrument cluster twice** within seconds on a G21
  (2026-11-09, cluster-render log: "Dcsm2 not available" 5 s and 2 s after the HUD was shown). The car
  showed brake, ABS and stability warnings and "Driver assistance restricted" until it had slept, and
  cluster-render's guard turned the HUD off.
- The likely cause is the cluster's GPU limits: OpenGL ES 2 only promises 16 uniform vectors a shader
  and many embedded chips stop at 64; this shader used about 70, and a lot of work a pixel. A desktop
  GPU (where it was checked, in WebGL) allows over 1000, so nothing showed there.
- A cluster restart while driving is a safety risk (speedometer, warning lights and driver assistance
  gone or limited for seconds), and a shader is sent whenever its layer is made: at start, after a
  cluster-render restart, or on a Sport / Comfort switch to another layout.
- What it would have saved is small: the picture path sends about 100 KB/s, where the cluster map sends
  about 3.8 MB/s. A smaller shader for the Arc alone (8 colours, ~22 uniform vectors) ran without trouble,
  but its shift lights felt slightly late next to the picture.

So every layout is a picture. A GPU path would need shaders kept well inside what the cluster takes, made
only while parked, and tested parked first.

**Gear font** (*Gear font*): Auto (Barlow SemiBold on Arc, Ramp and Dial, Ubuntu on the others),
Ubuntu or Barlow. Barlow (SIL Open Font License 1.1, `kit/runtime/fonts/OFL-Barlow.txt`) is the free
font closest to the BMW Type digits these HUDs use; BMW's own font can't be shipped. A font that is
missing falls back to Ubuntu.

**Palettes** (*Colours*): Colour (green / yellow / red), Night amber, Ice white.

**Choosing a look: the HUD looks tab.**

- **Live preview:** on the left, your HUD as set up at twice its size, playing a scripted drive.
  It counts in, flashes, shifts (graded spot on, early or late in turn), hits the limiter, then
  brakes with the downshift arrows counting up. It uses the HUD's own drawing code and your
  current settings, so every change shows in it at once.
- **Picking:** on the right, the nine layouts; tap one to use it.
- **Sport or Comfort:** under the preview, **SPORT** and **COMFORT / ECO PRO** pick the setup you're
  looking at and changing; with Comfort picked, *Same as Sport*, *Its own* or *Don't show* beside it.
  Everything on the page then shows and changes that setup (size and position are shared).
- **Editing:** under that, five tabs, each showing its changes in the preview at once.
  Switches show a lit green dot when on.
  - **Look:** HUD colours (not on VFD and the M layouts, which keep their own), gear font, label
    size, and how the rpm reads (exact, steady, thousands).
  - **Gauge:** the shift lights (GT3, left to right, or off) and their colours (M, Race, one
    colour: the centre screen's too), which parts show (rev bar, gear, gear mode) and unlit
    segments (dim or hidden). Every part can be turned off, so the HUD can be, say, the lights alone.
  - **Readouts:** *Engine*: RPM, Boost, Torque, Power, G-force, Knock. *Temps*: Oil, Water,
    Gearbox, Outside, the cold-engine limit, and *Only when cold or hot*. Up to four show, in this
    order; when more are on, the last plain ones give way, so a cold or hot reading keeps its place.
  - **Alerts:** the shift grade (Burst / Simple / Off), the knock warning, the launch time, the
    peak marker, the limiter shake, and the downshift arrows (When braking / Always / Off; to every
    gear or the best one).
  - **Place:** smaller / bigger, and move left / right / up / down, live on the glass. Reset puts
    it back.
- **Play on HUD:** runs the same drive on the glass for 20 s (two loops). It's meant for when
  you're parked. Nothing is learned from it.
- Units (speed, temperature, torque, power, boost) are in *Settings → Units*. Everything above is
  also in Settings with *All HUD options here* on.

**Effects:**

- **Shift grade:** *Burst* (the default) pops the word in (PERFECT SHIFT for a spot-on shift, then
  EARLY, LATE, LIMITER or COLD REV), grows
  a ring from it and fades it out. *Simple* shows the plain word; *Off* shows nothing.
- **Shake on the limiter** (off by default): the whole picture jitters a couple of pixels while
  the bar, lights and gear flash red.

**Sport and Comfort** (two HUD setups): the car's driving mode (FES `statusFESVehicleDynamicSwitchHMI`,
as Live Data shows it) picks which one shows.

- **Sport** is used in Sport, Sport+ and Sport Individual, and also in Adaptive, a mode it doesn't
  know, or when the car doesn't send the mode, so the HUD never disappears for lack of a signal.
- **Comfort / Eco Pro** is one of three (*In Comfort / Eco Pro*, in Settings and on HUD looks):
  - *Same HUD as Sport* (the default): one HUD for every mode.
  - *Its own HUD*: a setup of its own: layout, colours, readouts, alerts, everything on HUD looks.
    It starts as a copy of Sport's. On HUD looks, with **COMFORT / ECO PRO** picked, changing
    anything makes Comfort its own, so nothing needs switching on first.
  - *Don't show*: Redline steps aside (BMW's own HUD shows) in Comfort and Eco Pro; it comes back as soon as the mode
    is Sport. Comfort's own setup, if it has one, is kept for later.
- Shared by both: size and position, units, the light colours and the downshift
  arrows (the centre screen uses those too).
- From 1.14 / 1.15, *In Comfort / Eco Pro: Hide* stays hidden, and *Shift lights and gear only*
  becomes Comfort's own setup without readouts or alerts.

HUD looks opens on the setup of the mode the car is in; *Play on HUD* plays the one picked there.

**The readouts row** (standard layout), left to right:

- **RPM:** the engine speed as a number (7-segment digits in the digital and VFD layouts).
- **Torque** (Nm or lb-ft) from the engine's own torque signal, and **power** (hp, PS or kW)
  worked out from torque and rpm. Both off by default.
- **Throttle** is left out for now: the accelerator pedal signal's scaling isn't confirmed (on a
  G21 it read 60-96 % at a light touch). It comes back once checked against the engine unit.
- **G-force:** sideways and forward / braking together, from the car's acceleration sensor. Off
  by default.
- **Outside temperature:** blue at 3 °C and below, where ice is possible. Off by default.
- **Boost:** in bar, from the iDrive sport display. It shows only once the car has sent a value
  that moves; some cars send a constant.
- **LIMIT:** the cold-engine shift point, while the cold guard holds it down.
- **Oil, water and gearbox temperatures.** On *Temperatures: only when cold or hot* (the
  default) a temperature shows only while it's cold, warming (oil under *Oil warm at*) or hot,
  so a warm car shows none.

At most four readouts fit; on a cold start the gearbox temperature gives way. For 1.5 s after
each upshift, the row shows that shift's grade instead (*Shift grade after each upshift*):
SPOT ON, EARLY, LATE, LIMITER or COLD REV, from Redline's scoring.

Black is see-through on the HUD glass, so everything is drawn on black. Unlit lights and bar
segments can be faint or hidden (*Unlit segments*).

The temperatures sit to the right of x 150. That's because BMW draws its driver-assistance
graphic (lanes, steering wheel, ACC distance) under the left of the bar.

Readout colours (Colour palette): blue is cold, yellow means the oil is still warming, white is
normal and red is hot. A reading with no data is left out.

### HUD settings (shown while the HUD is on)

Settings keeps the HUD short: **Show on HUD**, **HUD layout**, **In Comfort / Eco Pro** and **All HUD
options here**. Everything
else is on the **HUD looks** page, by picture and with a live preview. Switch *All HUD options here*
on to also list them in Settings, as five groups (*HUD: look*, *gauge*, *readouts*, *alerts*, *place*);
they set the Sport HUD (Comfort's own is set up on HUD looks). The rest of Settings is grouped too: *Shift point*, *Engine*, *Learning*, *Units* (all
five units, app-wide), *Screen*, and behind *Advanced settings*, the renderer and the HUD's frame
rate, readout refresh and hand-back. Every change shows on the HUD at once. The tables
below list them by what they do.

**HUD style:** how it looks.

| Setting | Values |
|---|---|
| Layout | Standard / Minimal / Split wings / 80s digital dash / VFD glow / Vector arcade / Arc / Ramp / Dial |
| Gear font | Auto (Barlow on Arc, Ramp and Dial) / Ubuntu / Barlow |
| Colours | Colour / Night amber / Ice white (not for VFD, Arc, Ramp or Dial, which have their own) |
| Shift lights | GT3 (outside in, flash) / left to right / off |
| Shift grade after each upshift | Burst / Simple / Off |
| Peak marker | on / off |
| Shake on the limiter | on / off (off: each shake step resends the whole picture) |
| In Comfort / Eco Pro | Same HUD as Sport / Its own HUD (set up on HUD looks) / Don't show (BMW's own HUD) |
| Unlit segments | dim / hidden |

**HUD readouts:** what it shows, each on its own switch.

| Setting | Values |
|---|---|
| Gear | on / off |
| RPM | on / off: a number in the readouts row; the 7-segment digits in the digital and VFD layouts |
| RPM readout | Exact (to 10 rpm, default) / Steady (to 50 rpm) / Thousands (KRPM 4.5) |
| Readouts refresh | 4 (default) / 10 / 20 a second. Faster sends more frames to the HUD while the numbers change (experimental) |
| Readout labels | Normal / Clearer (bigger, full brightness). Also under HUD looks → Look |
| Boost | on / off |
| Boost unit | bar / psi / kPa |
| Oil, Water, Gearbox temperature | on / off each |
| Cold-engine shift limit | on / off (the LIMIT readout while the cold guard holds the shift point down) |
| Launch time | on (default) / off: after a standing start, the 0-100 km/h (0-60 mph) time and its difference to your best, for 3 s ([Launch score](#launch-score)) |
| Knock warning | on (default) / off: KNOCK when the engine pulls timing ([Knock](#knock)) |
| Knock retard | off (default) / on: the degrees knock control takes, only while it takes some |
| Temperatures | only when cold or hot / always |
| Temperature unit | °C / °F, in the app and on the HUD (the cold and hot colours go by °C either way) |
| Torque unit | Nm / lb-ft, on the HUD and the Learned page's torque curve |

At most four readouts fit the row; past that the last one gives way.

**HUD position and size:** set once.

| Setting | Values |
|---|---|
| Size | 70–130 %, scaled about the top centre |
| Position left / right, up / down | px; moves the layer only. HUD looks → Place warns when the tach reaches outside the part of the glass you see (as measured on one car by [bimmer-lab](https://github.com/bimmer-lab/apps), `shared/visible.js`, MIT) |
| Frame rate | 10 / 20 / 30 fps (20); see [Performance](#performance) |

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

### Gearbox mode (D / S / M)

Redline reads the programme the cluster shows by the gear (MDrive, as Car Vitals does). In **D**
or **S** the gearbox picks the shift moment, so those shifts don't teach the reaction time, don't
get a grade on the HUD, and the downshift arrows (*while slowing down*) stay off. In **M**,
including paddling from D, everything works. If the car never sends the programme, nothing is held
back. The HUD can show the mode as a small letter by the gear (*HUD readouts → Gearbox mode*). The
log lists the raw values (`gearbox programme: …`), so the detection can be checked on a new car.

### Reaction time

With *Shift lights early by* on **Auto**, each upshift after a flash you could see (HUD shown,
lights on) checks how late it came: (shift rpm − shift point) ÷ climb rate. The lead then moves
30 % of the way to what would have hit the point, within 0–600 ms. On a fast climb the flash can
come at most 800 rpm early, so the lead it really had is used (not the one asked for); otherwise
quick shifts in 1st and 2nd would push the lead up and make higher gears flash too early. A shift that
comes more than 700 ms after the revs started falling (you lifted first) is not used.

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

*Downshift arrows show*:

- **Every gear you can drop** (default): as above.
- **Best gear**: only as far as the power band, the lowest rpm where the engine makes 90 % of its
  peak power on the learned torque curve. No arrows when you're already in it; the fewest drops that
  reach it; all you can drop when none does. Until the curve is learned, the same as Every gear.

## Knock

The engine unit's knock control, the same values Live Data shows (*Ignition and knock*): its ignition
retard (DID `554C`, the cylinders' mean, 0.375° steps) and knock detected (`4A36`), read twice a second
over read-only diagnostics while the HUD shows and the engine runs (the gearbox reader's link).
**KNOCK** shows where the grade goes when the retard reaches 2.25° or the engine flags knock, and stays
while it does; it goes before a grade or launch time. On Minimal and Split wings, which show no grades,
the gear turns red (Minimal also writes KNOCK under its lights). The *Knock retard* readout shows the
degrees, only from 0.75°. A car whose engine unit doesn't answer `554C` shows nothing (logged once:
`knock: the engine unit gives no knock retard`). The threshold is from the catalogue's scaling and not
yet checked on a car.

## Launch score

Each standing start is timed 0-100 km/h and 0-60 mph by the run timer Drag Timer uses
(`kit/run_timer.js`: the launch found from a standstill, crossings interpolated between speed samples).
On the HUD, for 3 s, the time in your speed unit and its difference to your best before it: green for a
new best, yellow within 0.1 s, red further off; it goes after knock and a shift grade. Bests are kept
in `launch.json` and forgotten with *Reset all* on the Learned page. Times outside 1.8-30 s (1.7-28 s
for 0-60) aren't counted.

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
| `launch.json` | best launch times (0-100 km/h, 0-60 mph) | < 100 B | on a new best |

Learned files are written to a temp file and renamed, so a power cut can't corrupt them. On
load they are range-checked; a bad file is ignored and relearned.

To see what was learned, run this from a computer on the car's hotspot:

```sh
ssh root@172.16.222.97 "grep -h -E 'limiter|shiftmap|hud: |gearbox' /var/opt/public/oap/oap_*/data/redline*.log | tail -n 60"
```

Useful lines:

- `hud: target …`: what cluster-render reports (shown, parked behind BMW's content, disabled).
- `hud: target hud: slot 0x323 …`: cluster-render's report on the HUD's slot (each change): whether Redline
  or BMW's content (its navigation, with CarPlay) holds it.
- `hud: rpm samples every N ms`: how often the car sends rpm.
- `limiter: learned …`
- `shiftmap: 3>4 at 5550`
- `hud: shift at … (N ms late), reaction lead now …`
- `gearbox: EGS 6000 = … C`

## For developers

| File | What |
|---|---|
| `main.js` | The app: the screen pages, settings, scoring, and the wiring of everything below |
| `hud.js` | The HUD layer: connect, pace, smooth the rpm, decide what to show (readouts, grade, peak), send; `shiftCue()` (shared with the screen); the test pattern |
| `hud-draw.js` | Drawing the HUD image: the six layouts, the palettes, 7-segment digits, lights, bar and bar graph, readouts, grade burst, shake, downshift arrows; the cached static layer |
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
