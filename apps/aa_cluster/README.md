# AA Cluster Companion

Sets how Android Auto's Google Maps looks on the instrument cluster: the map density (150-300 dpi,
presets 180 / 200 / 240) and whether the phone's turn card shows. It changes settings only, through
the control socket of the **aa-on-cluster** tool (idrive-apps), which must be installed first and
needs a head-unit restart to apply a change. Without the tool the app shows a demo and says what
to install.

- `main.js` the screen, `ctl.js` the client for the tool's socket (`/dev/shm/aa-on-cluster/ctl.sock`).
- Build and preview as any app: `python3 kit/tools/build.py aa_cluster`.

Copyright (C) 2026 mlurker@gmail.com. GPL-3.0-or-later.
