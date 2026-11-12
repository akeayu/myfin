# MYFIN

MYFIN is a personal-finance application foundation, separate from ARNA/MASES.
This A3 branch establishes the first governed financial domain and persistence contracts.

## Local verification

Requires Node.js 22 or later.

```sh
npm install
npm run check
```

## A3 modules

- `src/domain/money.ts`: integer-minor-unit money arithmetic.
- `src/calendar/ethiopian.ts`: E.C./G.C. date-only conversion, Pagume, leap years and month arithmetic.
- `src/ledger/ledger.ts`: balanced journals, posted-entry invariants and reversal validation.
- `src/ledger/posting-service.ts`: transactional posting contract, idempotency and canonical SHA-256 content hashes.
- `migrations/001_finance_and_outbox.sql`: SQLite ledger/outbox schema, balance-on-posting and immutability triggers.
- `src/offline/outbox.ts`: durable-outbox interface, idempotency and version-conflict classification.
- `src/integration/iroka-contract.ts`: verified-token interface, scoped IROKA access and owner-approved proposals.
- `src/security/production-gates.ts`: fail-closed production security gate evaluator.

## Safety limits

Synthetic data only. Do not enter real financial data. The Android encryption failure,
Keystore lifecycle, WAL/journal/temp-file encryption, encrypted backup, recovery,
rotation and independent security review remain production blockers.

This branch does not authorize merge, deployment, production credentials, cloud sync,
or autonomous financial execution by IROKA.
