-- Calls that came from a Multica task (`agent_events.source = 'multica'`): where the report came
-- from and where the user's reply is posted. One row per event; one event per Multica task.
CREATE TABLE multica_reports (
  event_id          CHAR(36)      NOT NULL COMMENT 'agent_events.id (one-to-one)',
  workspace_id      CHAR(36)      NOT NULL,
  task_id           CHAR(36)      NOT NULL COMMENT 'Multica task whose task:completed produced the call',
  issue_id          CHAR(36)      NOT NULL,
  issue_identifier  VARCHAR(32)   NOT NULL COMMENT 'e.g. YOUT-149',
  issue_title       VARCHAR(1000) NOT NULL,
  agent_id          CHAR(36)      NOT NULL,
  agent_name        VARCHAR(200)  NOT NULL,
  report_comment_id CHAR(36)      NOT NULL COMMENT 'Last comment the task posted; the reply is posted under it',
  reply_comment_id  CHAR(36)      NULL     COMMENT 'Set once the user''s reply was posted',
  reply_content     MEDIUMTEXT    NULL,
  replied_at        DATETIME(3)   NULL     COMMENT 'UTC',
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id),
  UNIQUE KEY uk_multica_reports_task (task_id),
  CONSTRAINT fk_multica_reports_event FOREIGN KEY (event_id) REFERENCES agent_events (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
