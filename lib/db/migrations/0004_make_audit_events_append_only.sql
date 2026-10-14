-- Enforce append-only on audit_events in the database, not in prose.
--
-- schema.ts has claimed since 0000 that "nothing may edit a row: an audit trail
-- that can be rewritten is not evidence of anything." Until this migration that
-- was an aspiration -- there was no trigger, no rule and no revoke behind it,
-- and the application connects as the table owner, so no GRANT would help.
-- A trigger is the one control the owner cannot casually bypass.
--
-- UPDATE is rejected outright. There is no legitimate reason to rewrite a
-- recorded event: a correction is itself a new event.
--
-- DELETE is deliberately NOT blocked, and that is not an oversight. Document
-- retention (PROJECT-PLAN M5) has to be able to expire audit rows under a
-- policy that does not exist yet, and a trigger written now would be guessing
-- at its shape. This is a deferral, not a permission: no application code may
-- delete an audit event, and the retention mechanism that eventually does will
-- arrive with its own controls. If M5 lands without one, that is a defect.

-- The actor foreign key changes with it, and it has to. `actor_user_id` was
-- ON DELETE SET NULL, so deleting a user made Postgres issue
-- `UPDATE ONLY audit_events SET actor_user_id = NULL` -- an UPDATE, which the
-- trigger below rejects. The two properties the schema had claimed since 0000
-- were never compatible:
--
--   * "History survives the actor"  (SET NULL, AUTH-SCHEMA-RECONCILIATION.md)
--   * "nothing may edit a row"      (schema.ts)
--
-- Resolved in favour of the second. RESTRICT means a user who appears in the
-- audit trail cannot be hard-deleted at all, so attribution can never be
-- erased -- which is the whole point of recording it. This costs nothing
-- operationally: no code path hard-deletes a user. `users.deactivated_at` and
-- `users.deleted_at` are what the application uses, and both leave the row (and
-- therefore the trail's reference to it) intact.
--
-- If a user genuinely must be erased, that is now a deliberate, controlled
-- operation rather than a side effect of a DELETE -- the same class of decision
-- as the retention mechanism deferred to M5.

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_actor_user_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_user_id_users_id_fk
  FOREIGN KEY (actor_user_id) REFERENCES public.users(id)
  ON DELETE RESTRICT ON UPDATE NO ACTION;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_audit_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_events_reject_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_update();
