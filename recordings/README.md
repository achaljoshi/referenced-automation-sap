# Recordings

Drop SAP GUI Scripting recordings (`.vbs`) here, then convert them:

```bash
npm run build
npm run convert          # recordings/*.vbs  ->  tests/sapgui/*.spec.ts
```

Review each generated spec (the header lists anything that needs a human), then commit it.
**Do not commit the `.vbs` files if they contain a password** - the recorder writes whatever
you typed, in clear text. The converter never copies a password into the spec (it reads
`SAP_PASSWORD` from the environment), but it cannot stop the original recording being committed.
