# MYFIN A3 implementation boundaries

## Implemented in this branch

- Integer-minor-unit money values and decimal parsing.
- E.C./G.C. conversion using the Beyene–Kudlek Julian Day Number epoch, Pagume/leap-year handling and month arithmetic.
- A published E.C. 2012 Meskerem 1 reference vector and date round-trip tests.
- Double-entry journal validation, immutable posted-entry shape, reversal validation and a transactional posting-service contract.
- Canonical journal serialization and SHA-256 content hashing through Web Crypto.
- SQLite ledger/outbox schema with balance-on-posting, entity matching, reversal and immutability constraints.
- Offline outbox persistence/transport contracts, idempotency requirements and version-conflict classification.
- IROKA token-verifier interface, scope/expiry checks and human-approval-only proposal boundary.
- Fail-closed production security gate evaluator.

## Not yet implemented or verified

- Production SQLite repository adapter, migration runner and transaction/concurrency tests.
- Durable outbox adapter, retry scheduler, transport, server receipts and end-to-end conflict resolution.
- Full chart-of-accounts lifecycle, budgets, debt, goals, reporting and application/UI integration.
- A broad authoritative E.C. reference-vector suite, historical edge-case validation and independent calendar review.
- A concrete IROKA token signature verifier, issuer key rotation, consent workflow and production transport.
- Android SQLCipher, Keystore, WAL/journal/temp-file, backup, recovery and key-rotation verification.
- Runtime Android device tests, accessibility, performance and operational testing.

## Safety

Synthetic data only. No production credentials, cloud sync or real financial data.
Production readiness remains blocked until all security gates have evidence marked PASS,
including physical-device verification and independent security review.

## Governance

A3 work only. No merge, release, signing, deployment, production data intake, or A4/A5 closure.
