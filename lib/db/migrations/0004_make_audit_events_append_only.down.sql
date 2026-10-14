-- Reverses 0004. Dropping the trigger makes audit_events rewritable again --
-- which is precisely why this file exists only as the documented rollback path
-- and is not something to run casually.

DROP TRIGGER IF EXISTS audit_events_reject_update ON audit_events;
--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_audit_event_update();
--> statement-breakpoint

-- Restores ON DELETE SET NULL, which only makes sense once the trigger above is
-- gone: with the trigger present, the FK's nulling UPDATE is rejected and user
-- deletion fails outright. Reverse them in this order or not at all.
ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_actor_user_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_user_id_users_id_fk
  FOREIGN KEY (actor_user_id) REFERENCES public.users(id)
  ON DELETE SET NULL ON UPDATE NO ACTION;
