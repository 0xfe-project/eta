-- What a version is and how it is served: `kind` names the code that judged it and answers for it
-- (`artifacts/kinds/`), `manifest` is the JSON that code wrote when it was published. They are on
-- the version and not the artifact because a published version never changes, while one artifact
-- may take another kind in a later version. Every version before this is a plain static site.
ALTER TABLE artifact_version ADD COLUMN kind TEXT NOT NULL DEFAULT 'site';
ALTER TABLE artifact_version ADD COLUMN manifest TEXT NOT NULL DEFAULT '{}';
