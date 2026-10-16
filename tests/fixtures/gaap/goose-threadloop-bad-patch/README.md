# Real claim-bound Goose run with failed independent verification

Captured with `--case bad_patch` from clean ThreadLoop `c6f6bb0ec9f3cb532777f6e736f5e66d96764078` and clean
GAAP `0a82687d6070081e0a5cb613698f0724dc6f00cb`. Provenance, original IDs, signed bytes, raw stdout, adopted
binding and committed admission/journal records are retained alongside the checked blobs.

The real pinned Goose process executed three governed effects. Independent verification failed, so GAAP returned
`blocked`. ThreadLoop independently admitted that evidence, preserved the changed resulting subject and recorded
`unknown_outcome` under the frozen mapping. It required reconciliation and kept its own lifecycle at `implementing`,
state version 2. It didn't erase the effects or treat failure as permission to retry.

This uses the deliberately public fixture signer and a deterministic local provider, with no inference or external
billing. These exported records aren't imported production authority. The integration test verifies and maps their
original evidence independently.
