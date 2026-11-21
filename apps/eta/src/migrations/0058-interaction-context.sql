-- Why an agent asked: ask_user's `context`, shown under the question. Null when it gave none.
ALTER TABLE interaction ADD COLUMN context TEXT;
