-- Every device of the account rings at once; the first to answer takes the call and the others
-- stop (OUTB-57). `handled_by` is the device that answered, declined or acknowledged it: once set,
-- only that device may end the call, and the call is no longer replayed to the other devices.
ALTER TABLE agent_events
  ADD COLUMN handled_by CHAR(36) NULL COMMENT 'devices.id that answered or ended the call' AFTER status;
