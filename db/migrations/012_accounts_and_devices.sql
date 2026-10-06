-- Anonymous accounts and per-device tokens replace the one shared server token (YOUT-217).
-- An account is just an id. Every device (app, phone, outbrief-daemon) holds its own revocable
-- token; paired daemon machines become devices of kind `daemon` and keep their tokens.
CREATE TABLE accounts (
  id          CHAR(36)    NOT NULL,
  created_via VARCHAR(16) NOT NULL COMMENT 'signup | claim | migration',
  created_at  DATETIME(3) NOT NULL COMMENT 'UTC',
  PRIMARY KEY (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Data from before accounts belongs to the one user there was: a default account, created only
-- when there is something to own.
INSERT INTO accounts (id, created_via, created_at)
SELECT UUID(), 'migration', UTC_TIMESTAMP(3) FROM DUAL
WHERE EXISTS (SELECT 1 FROM machines) OR EXISTS (SELECT 1 FROM agent_events);

-- Foreign keys that point at `machines` follow the rename.
RENAME TABLE machines TO devices;

ALTER TABLE devices
  CHANGE COLUMN user_id account_id CHAR(36) NULL COMMENT 'accounts.id',
  ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'daemon' COMMENT 'daemon | app' AFTER account_id,
  MODIFY COLUMN token_hash CHAR(64) NOT NULL COMMENT 'hex SHA-256 of the device token',
  MODIFY COLUMN last_seen_at DATETIME(3) NULL COMMENT 'UTC; last connect or request';

UPDATE devices SET account_id = (SELECT id FROM accounts LIMIT 1);

ALTER TABLE devices
  MODIFY COLUMN account_id CHAR(36) NOT NULL COMMENT 'accounts.id',
  ADD KEY idx_devices_account (account_id, created_at),
  ADD CONSTRAINT fk_devices_account FOREIGN KEY (account_id) REFERENCES accounts (id);

ALTER TABLE agent_events
  ADD COLUMN account_id CHAR(36) NULL COMMENT 'accounts.id; only its devices see the call' AFTER id;

UPDATE agent_events SET account_id = (SELECT id FROM accounts LIMIT 1);

ALTER TABLE agent_events
  MODIFY COLUMN account_id CHAR(36) NOT NULL COMMENT 'accounts.id; only its devices see the call',
  DROP KEY idx_agent_events_status_seq,
  ADD KEY idx_agent_events_account_status_seq (account_id, status, seq),
  ADD CONSTRAINT fk_agent_events_account FOREIGN KEY (account_id) REFERENCES accounts (id);

-- One-time 6-digit codes that let a new device join an account (10 minutes, single use).
CREATE TABLE pairing_codes (
  code         CHAR(6)     NOT NULL,
  account_id   CHAR(36)    NOT NULL,
  created_by   CHAR(36)    NOT NULL COMMENT 'devices.id that showed the code',
  created_at   DATETIME(3) NOT NULL COMMENT 'UTC',
  expires_at   DATETIME(3) NOT NULL COMMENT 'UTC',
  used_at      DATETIME(3) NULL     COMMENT 'UTC',
  used_by      CHAR(36)    NULL     COMMENT 'devices.id that joined with it',
  PRIMARY KEY (code),
  KEY idx_pairing_codes_expires (expires_at),
  CONSTRAINT fk_pairing_codes_account FOREIGN KEY (account_id) REFERENCES accounts (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- One call per Multica task per account: two accounts watching the same workspace each get theirs.
ALTER TABLE multica_reports
  ADD COLUMN account_id CHAR(36) NULL COMMENT 'accounts.id of the event' AFTER event_id;

UPDATE multica_reports m JOIN agent_events e ON e.id = m.event_id SET m.account_id = e.account_id;

ALTER TABLE multica_reports
  MODIFY COLUMN account_id CHAR(36) NOT NULL COMMENT 'accounts.id of the event',
  DROP KEY uk_multica_reports_task,
  ADD UNIQUE KEY uk_multica_reports_account_task (account_id, task_id);
