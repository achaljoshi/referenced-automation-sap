# Recordings

Drop SAP GUI Scripting recordings (`.vbs`) here, then convert them:

```bash
npm run build
npm run convert          # recordings/*.vbs  ->  tests/sapgui/*.spec.ts
```

Add an assertion while you convert - `npm run convert -- --expect-text "Address" --expect-status "has been saved"` (also `--expect-title <regex>`) - and the converter picks the session fixture itself: a recording that contains the logon uses `sap`, one made while logged on uses `loggedInSap` (`--fixture sap|loggedInSap|auto`). Windows walk-through, from setup to the first run: README, "Windows first run".

Review each generated spec (the header lists anything that needs a human), then commit it.
**Do not commit the `.vbs` files if they contain a password** - the recorder writes whatever
you typed, in clear text. The converter never copies a password into the spec (it reads
`SAP_PASSWORD` from the environment), but it cannot stop the original recording being committed.
