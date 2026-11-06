# POS Next Desktop

Starting pieces for the Windows app, planned in phase 3 of
[the roadmap](../../docs/offline-multiplatform/05-roadmap.md). The app does not run yet: `electron/main.js`, storage and sign-in are still to come.

| File | Purpose | Source |
|---|---|---|
| `electron/printing/printer.js` | Silent printing through a hidden window | BrainWise `feature/electron-desktop`, without its receipt template |
| `package.json` | Windows installer settings | Same branch, with the Express server dependencies removed |
| `vite.config.electron.mjs` | Frontend build for the desktop app | Same branch, adapted to this folder |

The Express server, its routes and its sync engine were not taken. They duplicate the Frappe API in JavaScript, and they cannot run on Android.
