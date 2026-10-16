# Pinned GAAP signed-evidence schema

`terminal-run-v1.schema.json` preserves the exact schema from
[GAAP's merged signed-receipt adapter](https://github.com/nnennandukwe/governed-agent-autonomy-patterns/blob/c15d453dfa7059d64e45c7b75d748092beca1ac2/adapters/attestation/schema/terminal-run-v1.json).
Its SHA-256 is `ba983dbd8265b4d1c7d693ba3fe30d15e86b3ccde48a72a7aae7e5a6cb2409bb`; a test checks those bytes.

The Node consumer authenticates the original DSSE payload before parsing it. It then validates this schema and the
selected producer's contract identities. Rust's v1 serializers include nullable fields as explicit values or `null`, so
the consumer restores omitted optional fields before computing typed request/result/receipt identities. The original
signed bytes remain available separately. A digest computed by dropping those fields isn't accepted as a typed identity.

Every numeric field in this predicate is an integer. Its decoder rejects floating-point/exponent spellings and negative
zero in the typed predicate, matching Rust's typed deserialization. Signed whitespace changes remain valid; DSSE doesn't
require canonical payload bytes. Content identities use RFC 8785, while the process boundary uses the separately frozen
ThreadLoop codec and its shared conformance vectors.

Schema, signature and content verification don't grant workflow authority. Current claim/state/subject checks, durable
admission and ThreadLoop's controller guards remain separate requirements under
[ThreadLoop #111](https://github.com/nnennandukwe/threadloop/issues/111).
