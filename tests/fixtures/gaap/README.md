# Signed Goose evidence

`goose-*/` directories contain six unchanged public fixtures from GAAP's
[signed receipt adapter](https://github.com/nnennandukwe/governed-agent-autonomy-patterns/tree/c15d453dfa7059d64e45c7b75d748092beca1ac2/adapters/attestation/fixtures/goose).
`provenance.json` identifies the clean producer source and binary used for the native Goose execution. The local
provider uses deterministic protocol responses without inference or external billing.

The key in `fixture-trust.json` is public test data. Tests select it explicitly; the runtime has no default fixture
trust. `verification.json` is the producer's report and isn't trusted by ThreadLoop's independent verifier.

These bytes test independent authentication of a real GAAP receipt. Their request and run identities haven't been
rewritten, so this fixture alone doesn't prove a ThreadLoop claim-bound end-to-end run. That remains part of
[ThreadLoop #111](https://github.com/nnennandukwe/threadloop/issues/111).
