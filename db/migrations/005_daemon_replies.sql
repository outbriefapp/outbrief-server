-- Machines running outbrief-daemon. Each has its own bearer token (stored as a SHA-256 hash) that can
-- be revoked on its own, independent of the shared OUTBRIEF_TOKEN.
CREATE TABLE machines (
  id            CHAR(36)     NOT NULL,
  user_id       CHAR(36)     NULL     COMMENT 'Reserved for accounts; single-user for now',
  name          VARCHAR(200) NOT NULL COMMENT 'Usually the hostname',
  token_hash    CHAR(64)     NOT NULL COMMENT 'hex SHA-256 of the daemon token',
  created_at    DATETIME(3)  NOT NULL COMMENT 'UTC',
  last_seen_at  DATETIME(3)  NULL     COMMENT 'UTC; last WebSocket connect or report',
  revoked_at    DATETIME(3)  NULL     COMMENT 'UTC; revoked tokens are rejected',
  PRIMARY KEY (id),
  UNIQUE KEY uk_machines_token_hash (token_hash)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Machine whose daemon relayed the report; replies to the call are delivered to that machine.
ALTER TABLE agent_events
  ADD COLUMN machine_id CHAR(36) NULL COMMENT 'machines.id; null for Multica / direct HTTP reports' AFTER source;

-- Replies to daemon-relayed calls, waiting for or delivered to the machine's daemon.
-- queued -> dispatched (sent over the WebSocket) -> delivered | failed. One reply per event.
CREATE TABLE daemon_replies (
  id             CHAR(36)     NOT NULL COMMENT 'Reply id; the daemon executes each id at most once',
  event_id       CHAR(36)     NOT NULL,
  machine_id     CHAR(36)     NOT NULL,
  content        TEXT         NOT NULL,
  status         VARCHAR(16)  NOT NULL COMMENT 'queued | dispatched | delivered | failed',
  error          VARCHAR(2000) NULL    COMMENT 'Why it failed; null otherwise',
  created_at     DATETIME(3)  NOT NULL COMMENT 'UTC',
  dispatched_at  DATETIME(3)  NULL     COMMENT 'UTC; last time it was sent to the daemon',
  settled_at     DATETIME(3)  NULL     COMMENT 'UTC; delivered or failed',
  expires_at     DATETIME(3)  NOT NULL COMMENT 'UTC; a reply still queued by then fails',
  PRIMARY KEY (id),
  UNIQUE KEY uk_daemon_replies_event (event_id),
  KEY idx_daemon_replies_machine_status (machine_id, status),
  KEY idx_daemon_replies_status_expires (status, expires_at),
  CONSTRAINT fk_daemon_replies_event FOREIGN KEY (event_id) REFERENCES agent_events (id),
  CONSTRAINT fk_daemon_replies_machine FOREIGN KEY (machine_id) REFERENCES machines (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
