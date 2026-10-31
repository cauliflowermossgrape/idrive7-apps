# Live Adjustments

Live tweaks over the head unit's own diagnostic link (InternalTasu, DME `0x12`), one tab
each. Opening the app only reads; a command leaves only on a button press.

## Exhaust Flap

BMW's own `0x2F` job on DID `0x60FD` (Bosch MG1 / DME8): `2F 60FD 03 03E8` open,
`2F 60FD 03 2328` close, `2F 60FD 00` hands the flap back to the DME. The *Exhaust Flap*
setting is the arm switch and ships **Disarmed** (simulated, nothing is sent). Tested on one
car with an MG1.

## Tuned DME: BM3 and MHD

Engine Map, Burbles, Active Sound and Max Cooling are **not BMW jobs**: the tuner's code in
the DME handles them. Pick the tuning software the car runs in Settings, *Tuning software*,
and its tabs appear. It ships **Off**, and then nothing at all is sent — no detection, no
command — and no extra tab appears. Code: `tune.js`.

| Tab | BM3 | MHD |
|---|---|---|
| Engine Map | maps 1–4, memory write, confirmed by read-back | `2F 01 <map-1>`, accepted on the DME's echo |
| Burbles | aggression 0–12 in 0.5 steps, read-back, Off | — |
| Active Sound | ASD on / off (`2E 5FFD 00` / `01`), accepted, not read back | — |
| Max Cooling | — | `2F 03 01` / `2F 03 00`, accepted on the echo; **On only with the engine running** (live engine speed over 500 rpm, demo data never counts); Off always |

**BM3** (this replaces the separate BM3 Live app; `bm3_protocol.js`, `bm3_profiles.js`): when
BM3 is picked, the app reads the CustomROM marker and it must match a known ROM profile in
`bm3_profiles.js`. Unknown ROMs are rejected and no memory is written. `config.bm3MarkerAddress`
in `app.json` is the firmware-dependent marker location (limited validation). The profiles
hold only ROM identifiers and address / scale metadata, no tune contents. This app is
independent of and unaffiliated with bootmod3.

**MHD** commands come from captures a1-mapping attached to PR #23. MHD's own marker sits at a
ROM-dependent address (`0x807FF750` in that capture; another MG1 answered `7F 23 72` there),
so it is not read: a press counts only when the DME echoes it back. An untuned DME refuses it
and the tab says *Not available on this car*. No read-back of the active map is known, so the
screen says *accepted*, never *confirmed*.

**Validated on a car** (one MG1 with MHD multi-map): Engine Map and Max Cooling work from the
app. Over ENET, `2F 01 01` was echoed and the engine note changed (map 2), and `2F 01 02` made
the check engine light flash (MHD's map-change indication) — the map page says that is
normal. None of the DIDs MHD reads (`22 3010/3020/3030/3031/3032/37FE/586A/4098`) changed
between map 1 and map 2. BM3: limited smoke testing on one G22 (as the former BM3 Live app).

**Other tuning software** (MG Flasher and others): add a choice to the `tuner` setting in
`app.json`, its tabs to `FEATURES` in `tune.js` and its commands there, with a test case in
`kit/tools/test_live_adjustments.js`. Contributions from owners who can capture the commands
on their own car are welcome; please test in the live emulator (`node kit/tools/emu.js
live_adjustments`) before opening a PR.

## xDrive (experimental)

Switches xDrive off (rear-wheel drive) until the next ignition cycle, using the DSC's own
diagnostic job `LMV_FUNKTION` (issue #28). The *xDrive (experimental)* setting ships **Off**:
then no tab appears and nothing is sent. Code: `xdrive.js`.

- DSC, diagnostic address `0x29`, DID `0xDBE1`: `22 DB E1` reads it (1 = xDrive on, 0 = off),
  `2E DB E1 00` switches xDrive off. The app sends no "on" command. A full ignition cycle
  (terminal 15 off, then on) brings xDrive back.
- The DSC accepts the write only with the ignition on, engine **off**, selector in P, parking
  brake on and the car stationary. The app also refuses unless live data shows the engine off,
  the car stationary and the selector not in R/N/D (it can't read the parking brake). The
  button has to be pressed twice within 6 s.
- With the engine off, DBE1 always reads 0, so the screen shows AWD / RWD only once the engine
  is running. Started in the same ignition cycle, the cluster shows an all-wheel-drive notice.
- Only the tab reads the DSC: the SGBD index (`22 F1 50`) once, then DBE1 every 4 s. A DSC that
  refuses the read (a rear-wheel-drive car) is never written to.
- Front-axle torque, to see the effect while driving: the transfer case (LMV, `0x19`), `22 DB 32`
  (`LMV_MOMENT`: actual and requested Nm, raw / 4), every second while the tab is shown and the
  engine runs, plus the highest requested value while moving. With xDrive off it stays at 0 Nm.

Research: ezl0l's G22 M440i tests (DSC_G20, SGBD index `0F2510`; gist linked on issue #28),
including a short closed-area drive where the LMV's front-axle torque request stayed at 0;
IterioDev confirmed it on a 2023 230i xDrive. **Not established:** physical clutch state,
ABS / stability control in motion, other DSC variants, prolonged use. Use at your own risk.

## Build and test

```sh
python3 kit/tools/build.py live_adjustments
node kit/tools/test_live_adjustments.js     # in-memory DMEs: off / MHD / BM3 / wrong tune / untuned; in-memory DSC: xDrive
node kit/tools/test_bm3_protocol.js         # BM3 protocol and ROM profiles
```
