-- Additive only: one new array column with a default. Safe for a rolling deploy.

-- Which of this board's themes a reader wants to hear about. Empty means all of them — different
-- from the empty "statuses" beside it, which means silence. Narrowing by theme is opted into;
-- choosing no columns is choosing nothing.
ALTER TABLE "BoardNotificationPreference" ADD COLUMN "themeIds" UUID[] NOT NULL DEFAULT '{}';
