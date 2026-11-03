# AA Cluster Companion

Sets how Android Auto's Google Maps looks on the instrument cluster: the map density (150-300 dpi,
presets 180 / 200 / 240) and whether the phone's turn card shows. A change waits for a head-unit
restart, which the app offers.

## Dependency: aa-on-cluster

This app only **controls** the **aa-on-cluster** tool; it does not put the map on the cluster itself.
aa-on-cluster is in the [idrive-apps](https://github.com/robertnisipeanu/idrive-apps) repository
(`native/aa-on-cluster`, [pull request 44](https://github.com/robertnisipeanu/idrive-apps/pull/44))
and must be installed first, version 0.5.0 or newer. The app talks to the tool's control socket
(`/dev/shm/aa-on-cluster/ctl.sock`), which changes the density and turn card as root. Without the tool
the app shows a demo and says what to install.

- `main.js` the screen, `ctl.js` the client for the tool's socket (`/dev/shm/aa-on-cluster/ctl.sock`).
- Build and preview as any app: `python3 kit/tools/build.py aa_cluster_companion`.

Copyright (C) 2026 mlurker@gmail.com. GPL-3.0-or-later.
