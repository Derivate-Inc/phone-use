-- Bill to when deletion was requested, not when the worker completed it.
ALTER TABLE sandboxes ADD COLUMN delete_requested_at INTEGER;
