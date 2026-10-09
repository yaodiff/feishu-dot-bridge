# TEST ONLY: unpooled callback benchmark baseline

`callback-unpooled-baseline.ts` is an untouched baseline transport snapshot, except for the relative `types.js` import needed for this fixture location. Production code must never import it.

Source: the reviewed pre-pool `src/callback-proxy-candidate.ts` snapshot
Original SHA-256: `04cb26db18fc24644f4bc92022ae5d9d070932e4df2c5359958e1588dde89655`

The pool test validates the original-source checksum after reversing that sole import-path change. The benchmark uses this compiled fixture with synthetic loopback HTTPS/CONNECT services only.
