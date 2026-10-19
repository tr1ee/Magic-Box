# Project instructions

## Local packaging is part of every update

- Treat an implementation update as incomplete until the local WebView2 desktop package has been rebuilt successfully.
- After changing application, UI, server, shared, desktop, or packaging code, run the relevant tests and production build, then run:

  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-webview2.ps1`

- Verify that the changed code/assets are present under `release/chromium/MagicBox`, including packaged server or frontend files when applicable.
- In the final handoff, report the local executable at `release/chromium/MagicBox/MagicBox.exe` and state whether packaging succeeded.
- If packaging or packaged-artifact verification fails, do not describe the update as complete; report the failure and continue fixing it when possible.
