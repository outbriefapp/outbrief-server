-- Calls wake the account's phones with a push (ADR 0010): a phone off the event stream (asleep,
-- killed, between networks) heard of a call only when it reconnected, often past the ring window.

-- Where to push a device: its Firebase Cloud Messaging registration token. One per device.
CREATE TABLE device_push_tokens (
  device_id   CHAR(36)     NOT NULL,
  provider    VARCHAR(16)  NOT NULL COMMENT 'fcm',
  token       VARCHAR(512) NOT NULL COMMENT 'Opaque registration token of the provider',
  updated_at  DATETIME(3)  NOT NULL COMMENT 'UTC',
  PRIMARY KEY (device_id),
  CONSTRAINT fk_device_push_tokens_device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- A device heard of a call (by push or on its stream). Pushes stop for a device once it has one.
CREATE TABLE call_receipts (
  event_id     CHAR(36)    NOT NULL,
  device_id    CHAR(36)    NOT NULL,
  via          VARCHAR(8)  NOT NULL COMMENT 'push | stream',
  received_at  DATETIME(3) NOT NULL COMMENT 'UTC; when the server got the receipt',
  PRIMARY KEY (event_id, device_id),
  KEY idx_call_receipts_received (received_at),
  CONSTRAINT fk_call_receipts_event FOREIGN KEY (event_id) REFERENCES agent_events (id),
  CONSTRAINT fk_call_receipts_device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Outbox: written in the transaction that stores the call, so a restart between the commit and the
-- send loses no push. Each attempt is a row; a sent one schedules the next until a receipt arrives.
CREATE TABLE push_jobs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id    CHAR(36)        NOT NULL,
  device_id   CHAR(36)        NOT NULL,
  attempt     TINYINT UNSIGNED NOT NULL COMMENT '1 for the first push of the call to the device',
  state       VARCHAR(8)      NOT NULL COMMENT 'pending | sent | skipped | failed',
  due_at      DATETIME(3)     NOT NULL COMMENT 'UTC',
  error       VARCHAR(500)    NULL     COMMENT 'Why it failed or was skipped',
  settled_at  DATETIME(3)     NULL     COMMENT 'UTC',
  PRIMARY KEY (id),
  KEY idx_push_jobs_state_due (state, due_at),
  KEY idx_push_jobs_event (event_id),
  CONSTRAINT fk_push_jobs_event FOREIGN KEY (event_id) REFERENCES agent_events (id),
  CONSTRAINT fk_push_jobs_device FOREIGN KEY (device_id) REFERENCES devices (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
