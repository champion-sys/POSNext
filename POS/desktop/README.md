# POS Next Desktop

Starting pieces for the Windows app, planned in phase 3 of
[the roadmap](../../docs/offline-multiplatform/05-roadmap.md). The app does not run yet: `electron/main.js`, storage and sign-in are still to come.

| File | Purpose | Source |
|---|---|---|
| `electron/printing/printer.js` | Silent printing through a hidden window | BrainWise `feature/electron-desktop`, without its receipt template |
| `electron/updater.js` | Downloads updates in the background and installs them on quit | New |
| `package.json` | Windows installer settings | Same branch, with the Express server dependencies removed |
| `vite.config.electron.mjs` | Frontend build for the desktop app | Same branch, adapted to this folder |

The Express server, its routes and its sync engine were not taken. They duplicate the Frappe API in JavaScript, and they cannot run on Android.

## Building

`.github/workflows/build-windows.yml` builds the installer on `windows-latest`. To build on a Windows machine:

```
cd POS && yarn install
cd desktop && npm install
$env:POS_NEXT_UPDATE_URL = "https://updates.example.com/pos-next/"
npm run dist:win
```

`POS_NEXT_UPDATE_URL` is the folder the app checks for updates. It is built into the installer, so it must point at a server you control. Upload the installer, its `.blockmap` and `latest.yml` from `dist/` to that folder to publish an update.
