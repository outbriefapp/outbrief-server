-- Login accounts, server-side briefs, and the server TTS quota are gone (ADR 0006, ADR 0007).
-- Drop whatever is still there. Fresh databases never create these tables.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS briefs;
DROP TABLE IF EXISTS tts_usage;
