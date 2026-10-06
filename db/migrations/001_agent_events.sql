-- Agent reports delivered by outbrief-hook; one row per "incoming call".
CREATE TABLE agent_events (
  seq          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Monotonic sequence; SSE id / polling cursor',
  id           CHAR(36)        NOT NULL COMMENT 'Public UUID',
  source       VARCHAR(32)     NOT NULL COMMENT 'claude-code | codex | gemini-cli | generic',
  session_id   VARCHAR(200)    NULL     COMMENT 'Agent-native session id, used to resume the session',
  cwd          VARCHAR(1000)   NULL     COMMENT 'Working directory the agent ran in',
  title        VARCHAR(200)    NULL,
  content      MEDIUMTEXT      NOT NULL COMMENT 'Final report, verbatim (<= 200k chars)',
  status       VARCHAR(16)     NOT NULL COMMENT 'received | completed | dismissed',
  occurred_at  DATETIME(3)     NOT NULL COMMENT 'UTC',
  received_at  DATETIME(3)     NOT NULL COMMENT 'UTC',
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (seq),
  UNIQUE KEY uk_agent_events_id (id),
  KEY idx_agent_events_status_seq (status, seq)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
