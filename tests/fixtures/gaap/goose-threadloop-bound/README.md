# Real ThreadLoop-bound Goose receipt

Captured by `npm run prove:gaap:goose` from clean ThreadLoop `a0dca15d479a09c6210d55852e7f20e8dc36da3f` and
clean merged GAAP `0a82687d6070081e0a5cb613698f0724dc6f00cb`. `provenance.json` retains the host/attestor binary
identities and the original ThreadLoop request, claim and Attempt identifiers.

The real checksum-pinned Goose 1.54.0 process used a local deterministic provider with no inference or external billing.
ThreadLoop created its claim/Attempt and mapped request before the three governed effects ran. The envelope and process
stdout bytes are unchanged. The signer uses GAAP's deliberately public fixture seed and requires explicit test trust.

`binding.json` and `executor-request.json` retain the adopted input. `admission.json`, `execution-journal.json` and
`inspection.json` export the already committed runtime records; the snapshot and raw files remain under `blobs/`.
The Node consumer independently authenticated and admitted the evidence before evaluating its own outgoing guards.
GAAP completed, while ThreadLoop remained `implementing` at state version 2 because the commit guard wasn't satisfied.

The integration test independently replays signature, predicate, content and mapping verification from these bytes.
It doesn't import asserted authority from the exported journal into production or rewrite/re-sign earlier IDs.
