# M Drive

The engine's vitals on one screen, with the MHD tune's controls under them. A full-width rev bar
(0–8,000 rpm, red from 7,000), five round dials and three groups of buttons:

| Dial | Range | Source |
|---|---|---|
| Engine oil | 40–160 °C | CDS `statusEngineTemperature` (raw − 48) |
| Coolant | 40–140 °C | CDS `statusEngineTemperature` (raw − 48) |
| Gearbox oil | 40–160 °C | BasicDataSet `valueTemperatureTransmissionOil` (raw − 48), once it has moved by 1 °C; else the gearbox unit (EGS `0x18`, `22 6000`, raw − 40) |
| Intake air | −20–120 °C | DME `0x12`: `22 F40F`, `22 F477`, OBD `01 0F` |
| Boost | 0–3 bar | FES `statusSwitchDriveDynamicSport2` (raw × 0.01 bar), once it has moved; else the DME's absolute pressure (`22 F470` / `F487` / `F40B`, OBD `01 0B`) minus the outside air pressure read from the DME (`22 F433`, OBD `01 33`) |

The engine speed is CDS `statusEngineSpeed2`. A reading the car has not given shows `--`; nothing
is filled in. The DID candidates are M Vitals' (`apps/car_vitals/app.json` `config.dme`), copied into
this app's `config.dme`; `kit/tools/test_m_drive.js` fails when the two drift apart. Without an
outside pressure reading there is no boost from the DME: an absolute pressure is never shown as
boost. The DIDs are read only while the screen shows and no demo runs, one request at a time, also
with Car controls off.

| Group | Buttons | Sent to the DME (`0x12`) | Selected when |
|---|---|---|---|
| MHD map | Map 1–4 | `2F 01 00` … `2F 01 03` | the DME echoes `6F 01 nn` |
| Exhaust flap | OEM, Open, Closed | `2F 60FD 00`, `2F 60FD 03 03E8`, `2F 60FD 03 2328` (BMW's own job on MG1 DMEs that answer `22 62FD` / `64FD`) | the DME echoes `6F 60FD ..` |
| Max Cooling | On, Off | `2F 03 01`, `2F 03 00` | the DME echoes `6F 03 nn` |

Nothing is shown selected at the start: MHD has no read-back of the active map or of Max Cooling,
so only an echo in this session lights a button. A refusal or no answer says so in the line under
the buttons and keeps the selection the DME last took.

## When something is sent

One setting decides: **Car controls**, Off by default. Off, or with demo data, the app sends no
command at all. Commands, never reads, also need the screen shown and the diagnostic link up.

- **Transport mode.** `demo` (demo data shown: buttons select a simulated preview drawn in amber,
  marked *simulated*, nothing is sent), `disarmed` (live data, Car controls Off) or `live`. The
  header badge names it: DEMO, CONTROLS OFF, LIVE, NO LINK.
- **One queue.** Every request of the app (DID polls, the DME identification, map, cooling and flap
  commands) waits for the one before it to be answered. A `2F` request's reply filter takes any
  `7F 2F` refusal, so two in flight could take each other's answer.
- **Checked when it goes.** Right before the request leaves (also when the transport turned it away
  as busy and it goes again 1–4 s later), a command is checked again: Car controls On, live data,
  the screen shown, the link up, and nothing changed since it was pressed. Max Cooling On also needs
  a fresh live engine speed over 500 rpm (its own timestamp: the temperatures do not keep it fresh),
  and the flap's Close one under 4,000 rpm.
- **Phases.** Switching demo / live, Car controls, losing or getting back the link, and leaving the
  screen start a new phase. Commands and the flap's hold from the old phase are dropped, simulated
  selections are cleared, and map and cooling acceptance belongs only to that screen session.
  Returning to the screen starts with unknown selections. Getting the link back sends nothing.
- **Flap.** Engine Config's `auto.js`: Open / Closed are sent again every 15 s while the screen
  shows (the DME lets a tester's command go after ~20 s), Close is handed back above 4,000 rpm and
  resumed below 3,500 rpm, and a manual Close without a live engine speed becomes OEM. The driving
  mode never moves the flap here.
- **Opening the app** only reads. The DME's VIN is read for the identification but not logged.

## Controls on every screen

The nine buttons are drawn on the page where the kit runs the screen (the Store's `mgu-render`
with touch, full-screen layout): taps and the iDrive controller reach them, and Settings is the
header's last tab. Everywhere else (the software renderer, the standard layout, a renderer
without touch routing) the page shows them as state, and the HMI's own bar has the nine buttons
plus Settings, for touch and the controller.

## Code

`main.js` wires it together, `model.js` holds the domain (transport mode, the nine controls, what
each group shows, which request may go), `lane.js` the one queue and the check before each send,
`telemetry.js` the readings, `ui.js` the screen. The DME and flap logic is Engine Config's,
staged beside these files by `build.py` from `app.json` `sharedSources`:
`apps/live_adjustments/{tune,controller,auto,diaglink,adapters,real_adapters,bm3_protocol,bm3_profiles}.js`.
Engine Config is unchanged.

## Build, test, preview

```sh
python3 kit/tools/build.py --preview-only m_drive   # offline stage in dist/m_drive: no BMW SDK, NOT installable
node kit/tools/preview.js dist/m_drive preview wait=3 render                        # software frame -> preview/main_gfx-*.png
node kit/tools/preview.js dist/m_drive preview wait=3 render --gpu preview/m_drive.bin   # + the renderer's stream
node kit/tools/emu.js m_drive --preview-only        # live emulator: http://localhost:8077
node kit/tools/test_m_drive.js                      # behaviour tests (stages its own copy; M_DRIVE_OUT=dir keeps frames)
python3 kit/tools/build.py m_drive                  # installable dist/m_drive@1.0.0.mgu / .tgz: needs oap-sdk/
```

**SDK.** BMW's `oap-sdk` is not in this repository. Without it `build.py` only stages the app
(`--preview-only`): it runs on a PC in the preview, the emulator and the tests, but it is not an
installable package. Extract the SDK from your own head unit (`kit/tools/extract_sdk.js`, see the
main README, 3.1) to build one.

## Limits

- Not yet run on a car. The MHD bytes and the flap job are Engine Config's (the MHD map switch was
  confirmed on one MG1, the flap job on an MG1 and a B48); this app adds no protocol.
- The flap needs a DME with BMW's electric flap job (`60FD`); others show *exhaust control not
  available on this car*.
- MHD reports neither the active map nor Max Cooling: after a link loss, a mode change or a restart
  they show unknown until pressed again.
- Turn Car controls on in only one app. Engine Config can keep its own exhaust-flap override active
  while another app is shown.
- Ten bar buttons on one canvas screen are more than the other apps use; the HMI's bar scrolls, as
  for Doom's eight.
