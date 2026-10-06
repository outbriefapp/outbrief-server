-- The server is a relay, not an archive (ADR 0006). Calls that already ended lose their report
-- and Multica issue title; settled replies lose their text. Only what routes a reply stays.
-- History lives on the user's devices from now on.
UPDATE agent_events SET title = NULL, content = '', cwd = NULL
WHERE status IN ('completed', 'dismissed');

UPDATE multica_reports m JOIN agent_events e ON e.id = m.event_id SET m.issue_title = ''
WHERE e.status IN ('completed', 'dismissed');

UPDATE daemon_replies SET content = '' WHERE status IN ('delivered', 'failed');

ALTER TABLE multica_reports DROP COLUMN reply_content;
