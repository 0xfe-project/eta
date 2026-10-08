-- +goose Up
-- Deleting a routine deletes its runs, their feedback and its briefs in the
-- database (Django's ORM used to cascade them itself); a brief revised from
-- deleted feedback keeps its text.

ALTER TABLE routine_run
    DROP CONSTRAINT routine_run_routine_id_c55d5f7a_fk_routine_id,
    ADD CONSTRAINT routine_run_routine_fk FOREIGN KEY (routine_id) REFERENCES routine(id) ON DELETE CASCADE;

ALTER TABLE routine_feedback
    DROP CONSTRAINT routine_feedback_run_id_5847bac4_fk_routine_run_id,
    ADD CONSTRAINT routine_feedback_run_fk FOREIGN KEY (run_id) REFERENCES routine_run(id) ON DELETE CASCADE;

ALTER TABLE routine_brief
    DROP CONSTRAINT routine_brief_routine_id_7fecbb03_fk_routine_id,
    ADD CONSTRAINT routine_brief_routine_fk FOREIGN KEY (routine_id) REFERENCES routine(id) ON DELETE CASCADE,
    DROP CONSTRAINT routine_brief_feedback_id_59380b0a_fk_routine_feedback_id,
    ADD CONSTRAINT routine_brief_feedback_fk FOREIGN KEY (feedback_id) REFERENCES routine_feedback(id) ON DELETE SET NULL;
