PRAGMA foreign_keys = ON;

CREATE TABLE entities (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  base_currency TEXT NOT NULL CHECK(length(base_currency) = 3),
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('asset','liability','equity','income','expense')),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(entity_id, code),
  UNIQUE(entity_id, id, currency)
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  idempotency_key TEXT NOT NULL,
  effective_date TEXT NOT NULL CHECK(length(effective_date) = 10),
  recorded_at TEXT NOT NULL,
  calendar_system TEXT NOT NULL CHECK(calendar_system IN ('ETHIOPIAN','GREGORIAN')),
  calendar_algorithm_version TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted')),
  posted_at TEXT,
  content_hash TEXT,
  reverses_entry_id TEXT REFERENCES journal_entries(id),
  UNIQUE(entity_id, idempotency_key),
  CHECK((status = 'draft' AND posted_at IS NULL AND content_hash IS NULL)
     OR (status = 'posted' AND posted_at IS NOT NULL AND length(content_hash) = 64
         AND content_hash NOT GLOB '*[^0-9a-fA-F]*'))
);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY NOT NULL,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  account_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  debit_minor INTEGER NOT NULL DEFAULT 0 CHECK(debit_minor >= 0),
  credit_minor INTEGER NOT NULL DEFAULT 0 CHECK(credit_minor >= 0),
  memo TEXT,
  FOREIGN KEY(entity_id, account_id, currency)
    REFERENCES accounts(entity_id, id, currency),
  CHECK((debit_minor > 0 AND credit_minor = 0)
     OR (credit_minor > 0 AND debit_minor = 0))
);


CREATE TRIGGER journal_line_must_match_entry_entity
BEFORE INSERT ON journal_lines
WHEN (SELECT entity_id FROM journal_entries WHERE id = NEW.journal_entry_id) IS NOT NEW.entity_id
BEGIN SELECT RAISE(ABORT, 'journal line entity must match journal entry entity'); END;

CREATE TRIGGER journal_line_update_must_match_entry_entity
BEFORE UPDATE OF journal_entry_id, entity_id ON journal_lines
WHEN (SELECT entity_id FROM journal_entries WHERE id = NEW.journal_entry_id) IS NOT NEW.entity_id
BEGIN SELECT RAISE(ABORT, 'journal line entity must match journal entry entity'); END;

CREATE UNIQUE INDEX one_reversal_per_entry ON journal_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE TRIGGER reversal_must_reference_posted_entry
BEFORE INSERT ON journal_entries
WHEN NEW.reverses_entry_id IS NOT NULL
BEGIN
  SELECT CASE WHEN (SELECT status FROM journal_entries WHERE id = NEW.reverses_entry_id) <> 'posted'
    THEN RAISE(ABORT, 'reversal target must already be posted') END;
  SELECT CASE WHEN (SELECT entity_id FROM journal_entries WHERE id = NEW.reverses_entry_id) <> NEW.entity_id
    THEN RAISE(ABORT, 'reversal and original must belong to the same entity') END;
END;

CREATE INDEX journal_entries_entity_date ON journal_entries(entity_id, effective_date);
CREATE INDEX journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX journal_lines_account ON journal_lines(account_id);

CREATE TRIGGER journal_entry_post_must_balance
BEFORE UPDATE OF status ON journal_entries
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM journal_lines WHERE journal_entry_id = NEW.id) < 2
    THEN RAISE(ABORT, 'posted journal requires at least two lines') END;
  SELECT CASE WHEN EXISTS (
    SELECT currency FROM journal_lines
    WHERE journal_entry_id = NEW.id
    GROUP BY currency
    HAVING SUM(debit_minor) <> SUM(credit_minor)
  ) THEN RAISE(ABORT, 'posted journal is not balanced by currency') END;
END;

CREATE TRIGGER posted_entry_no_update
BEFORE UPDATE ON journal_entries
WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted journal entries are immutable'); END;

CREATE TRIGGER posted_entry_no_delete
BEFORE DELETE ON journal_entries
WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted journal entries cannot be deleted'); END;

CREATE TRIGGER posted_line_no_insert
BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.journal_entry_id) = 'posted'
BEGIN SELECT RAISE(ABORT, 'cannot add lines to a posted journal'); END;

CREATE TRIGGER posted_line_no_update
BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journal_entry_id) = 'posted'
  OR (SELECT status FROM journal_entries WHERE id = NEW.journal_entry_id) = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted journal lines are immutable'); END;

CREATE TRIGGER posted_line_no_delete
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journal_entry_id) = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted journal lines cannot be deleted'); END;

CREATE TABLE sync_outbox (
  command_id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 0),
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  next_attempt_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','in_flight','acknowledged','rejected')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  server_receipt TEXT,
  rejection_code TEXT
);

CREATE INDEX sync_outbox_pending ON sync_outbox(status, next_attempt_at, created_at);
