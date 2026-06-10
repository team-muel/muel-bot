-- P1a (ADR-003): muel_user_memos 에 metadata jsonb 컬럼 추가.
-- /메모 add 직후 generateObject 로 자동 추출한 tags / kind / importance / visibility 등을
-- metadata 에 저장. fire-and-forget 패턴으로 실패해도 메모 자체는 저장됨.
--
-- metadata schema (zod 와 sync, ADR-003 P1b):
--   { tags: string[], kind: 'preference'|'fact'|'project'|'decision'|'context',
--     importance: 1..5, language: string?, summary: string? }

ALTER TABLE IF EXISTS public.muel_user_memos
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS muel_user_memos_metadata_tags_idx
  ON public.muel_user_memos USING gin ((metadata -> 'tags'));

CREATE INDEX IF NOT EXISTS muel_user_memos_metadata_kind_idx
  ON public.muel_user_memos ((metadata ->> 'kind'));
