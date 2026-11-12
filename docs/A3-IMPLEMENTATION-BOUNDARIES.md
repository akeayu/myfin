# MYFIN A3 implementation boundaries
## Implemented in this branch
- Integer-minor-unit money values and decimal parsing.
- Ethiopian calendar conversion, Pagume/leap-year handling and month arithmetic.
- Double-entry journal validation, immutable posted-entry shape and reversal validation.
- Offline outbox persistence/transport contracts, idempotency requirements and version-conflict classification.
- IROKA principal scope/expiry checks and human-approval-only proposal boundary.
- Fail-closed production security gate evaluator.
## Not yet implemented or verified
- Persistent database adapters, schema migrations, durable outbox storage and transport retries.
- Cryptographic canonicalization and actual SHA-256 content-hash generation.
- Full chart-of-accounts, entity, budgets, debt, goals, reports and app integration.
- Independently sourced E.C. reference vectors and authoritative validation.
- Android SQLCipher, Keystore, WAL/journal/temp-file, backup, recovery and rotation verification.
- Authentication/token signature verification, key rotation, consent UI and production IROKA transport.
- Runtime, accessibility, performance and operational testing.
## Safety
Synthetic data only. No production credentials, cloud sync or real financial data.
Production readiness remains blocked until all security gates have evidence marked PASS,
including physical-device verification and independent security review.
## Governance
A3 work only. No merge, release, signing, deployment, production data intake, or A4/A5 closure.