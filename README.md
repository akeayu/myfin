# MYFIN

MYFIN is a personal-finance application foundation. It is separate from ARNA/MASES.
This A3 branch establishes domain contracts and an initial SQLite schema migration.

## Local verification

Requires Node.js 22 or later.

```sh
npm install
npm run check
```

## A3 modules

- `src/domain/money.ts`: integer-minor-unit money arithmetic.
- `src/calendar/ethiopian.ts`: Ethiopian/Gregorian date-only conversion, Pagume and month arithmetic.
- `src/ledger/ledger.ts`: balanced journal validation, posted-entry shape and reversal checks.
- `migrations/001_finance_and_outbox.sql`: SQLite schema, posting-balance trigger, immutable posted records and durable outbox table.
- `src/offline/outbox.ts`: persistence contract, idempotency and conflict classification.
- `src/integration/iroka-contract.ts`: scoped read/proposal authorization boundary.
- `src/security/production-gates.ts`: fail-closed production security gate evaluator.

## Non-negotiable safety limits

Synthetic data only. Do not enter real financial data. The Android encryption failure,
Keystore lifecycle, WAL/journal/temp-file encryption, encrypted backup, recovery,
rotation and independent security review remain production blockers.

This branch does not authorize merge, deployment, production credentials, cloud sync,
or autonomous financial execution by IROKA.
