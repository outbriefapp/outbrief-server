-- End-to-end encryption (ADR 0007): the report, its brief and every reply travel sealed with a key
-- only the user's devices hold. The server keeps the sealed text and what it routes by, nothing else.
-- Calls and replies still open from before are plaintext the clients no longer accept: end them.
UPDATE agent_events SET status = 'dismissed' WHERE status = 'received';

UPDATE daemon_replies
SET status = 'failed', error = '端到端加密上线前的回复，已作废', settled_at = UTC_TIMESTAMP(3)
WHERE status IN ('queued', 'dispatched');

ALTER TABLE agent_events
  DROP COLUMN session_id,
  DROP COLUMN cwd,
  DROP COLUMN title,
  DROP COLUMN content,
  ADD COLUMN sealed MEDIUMTEXT NULL COMMENT 'SealedReport (ob1.…); NULL once the call ended' AFTER machine_id;

ALTER TABLE multica_reports
  DROP COLUMN workspace_id,
  DROP COLUMN issue_id,
  DROP COLUMN issue_identifier,
  DROP COLUMN issue_title,
  DROP COLUMN agent_id,
  DROP COLUMN agent_name,
  DROP COLUMN report_comment_id;

ALTER TABLE daemon_replies
  CHANGE COLUMN content sealed MEDIUMTEXT NOT NULL COMMENT 'SealedReply (ob1.…); empty once settled',
  MODIFY COLUMN error TEXT NULL COMMENT 'Sealed by the daemon, or plain when the server / daemon failed it';

UPDATE daemon_replies SET sealed = '' WHERE status IN ('delivered', 'failed');
