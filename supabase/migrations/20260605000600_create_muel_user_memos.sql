-- 사용자가 /메모 명령으로 직접 추가한 메모를 저장하는 테이블.
--
-- 기존 `muel_memory_entries` 는 LLM 이 대화에서 자동 추출한 메모 전용 (chat 매핑).
-- 이 테이블은 *사용자 직접 입력* 만 다룬다. discord_user_id 로 user-level 분리.
--
-- /메모 목록 은 두 테이블을 union 해서 같은 카드 그리드로 보여준다.

CREATE TABLE IF NOT EXISTS public.muel_user_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muel_user_memos_user_created_idx
  ON public.muel_user_memos(discord_user_id, created_at DESC);

ALTER TABLE public.muel_user_memos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access to muel_user_memos" ON public.muel_user_memos;
CREATE POLICY "Allow service role full access to muel_user_memos"
  ON public.muel_user_memos
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON TABLE public.muel_user_memos FROM anon, authenticated;
GRANT ALL ON TABLE public.muel_user_memos TO service_role;

CREATE OR REPLACE FUNCTION public.set_muel_user_memos_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_muel_user_memos_updated_at ON public.muel_user_memos;
CREATE TRIGGER set_muel_user_memos_updated_at
  BEFORE UPDATE ON public.muel_user_memos
  FOR EACH ROW
  EXECUTE FUNCTION public.set_muel_user_memos_updated_at();

REVOKE EXECUTE ON FUNCTION public.set_muel_user_memos_updated_at() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_muel_user_memos_updated_at() TO service_role;
