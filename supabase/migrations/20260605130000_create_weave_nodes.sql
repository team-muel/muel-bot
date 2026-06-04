-- 20260605130000_create_weave_nodes.sql
-- ADR-002: Research / Subscription → Weave Knowledge Tree 통합.
--
-- 기존엔 AI-Q 리서치 리포트 / YouTube 구독 신호 / 메모가 각자 다른 테이블에만
-- log 로 적재되고 사용자에겐 DM·채널 1회성으로만 도달 → 후방 자산으로 안 남음.
-- weave_nodes 는 *모든 지식 자산* 의 단일 멀티소스 모델. muel-tree /weave 가
-- 이 테이블을 시각화(그래프/피드)하여 "사용자가 가꾸어 나가는 지식의 나무" 로 노출.
--
-- producer (muel-bot): 각 데이터 발생 시 fire-and-forget 으로 insert_weave_node 호출.
-- consumer (muel-tree): visibility 별 read (private=owner 본인, community=길드 멤버).

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.weave_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN (
    'dream',                  -- 기존 꿈 기록 (muel_dreams backfill 대상)
    'research_report',        -- AI-Q 리포트
    'subscription_signal',    -- 일반 구독 신호 (메타 + 텍스트 요약)
    'community_video',        -- 커뮤니티 영상
    'community_post',         -- 커뮤니티 게시글 (이슈/공지/장문)
    'user_memo',              -- /메모 add 직접
    'auto_memo'               -- memoryWorker 자동 추출
  )),
  owner_user_id text NULL,    -- 사적 노드면 채워짐, 커뮤니티 공유면 NULL
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'community')),
  title text NULL,
  body text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  source_ref jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 원본 참조 (research job id / signal id / memo id ...)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.weave_node_embeddings (
  node_id uuid PRIMARY KEY REFERENCES public.weave_nodes(id) ON DELETE CASCADE,
  embedding extensions.vector(768) NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS weave_nodes_visibility_created_idx
  ON public.weave_nodes(visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS weave_nodes_owner_created_idx
  ON public.weave_nodes(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS weave_nodes_source_kind_idx
  ON public.weave_nodes(source_kind);
CREATE INDEX IF NOT EXISTS weave_node_embeddings_vector_idx
  ON public.weave_node_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- RLS --------------------------------------------------------------------
ALTER TABLE public.weave_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weave_node_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access to weave_nodes" ON public.weave_nodes;
CREATE POLICY "Allow service role full access to weave_nodes"
  ON public.weave_nodes
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access to weave_node_embeddings" ON public.weave_node_embeddings;
CREATE POLICY "Allow service role full access to weave_node_embeddings"
  ON public.weave_node_embeddings
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON TABLE public.weave_nodes FROM anon, authenticated;
REVOKE ALL ON TABLE public.weave_node_embeddings FROM anon, authenticated;
GRANT ALL ON TABLE public.weave_nodes TO service_role;
GRANT ALL ON TABLE public.weave_node_embeddings TO service_role;

-- updated_at trigger -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_weave_nodes_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_weave_nodes_updated_at ON public.weave_nodes;
CREATE TRIGGER set_weave_nodes_updated_at
  BEFORE UPDATE ON public.weave_nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_weave_nodes_updated_at();

REVOKE EXECUTE ON FUNCTION public.set_weave_nodes_updated_at() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_weave_nodes_updated_at() TO service_role;

-- insert_weave_node ------------------------------------------------------
-- producer 단일 진입점. node + (optional) embedding 을 한 트랜잭션에 insert.
-- embedding 은 nullable — 임베딩 실패해도 노드는 남도록 (producer fire-and-forget).
CREATE OR REPLACE FUNCTION public.insert_weave_node(
  p_source_kind text,
  p_owner_user_id text,
  p_visibility text,
  p_title text,
  p_body text,
  p_tags text[],
  p_source_ref jsonb,
  p_embedding extensions.vector(768),
  p_embedding_model text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_node_id uuid;
BEGIN
  INSERT INTO public.weave_nodes (source_kind, owner_user_id, visibility, title, body, tags, source_ref)
  VALUES (
    p_source_kind,
    p_owner_user_id,
    COALESCE(p_visibility, 'private'),
    p_title,
    p_body,
    COALESCE(p_tags, '{}'),
    COALESCE(p_source_ref, '{}'::jsonb)
  )
  RETURNING id INTO v_node_id;

  IF p_embedding IS NOT NULL AND p_embedding_model IS NOT NULL THEN
    INSERT INTO public.weave_node_embeddings (node_id, embedding, embedding_model)
    VALUES (v_node_id, p_embedding, p_embedding_model);
  END IF;

  RETURN v_node_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.insert_weave_node(text, text, text, text, text, text[], jsonb, extensions.vector(768), text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_weave_node(text, text, text, text, text, text[], jsonb, extensions.vector(768), text) TO service_role;

-- match_weave_nodes ------------------------------------------------------
-- 임베딩 코사인 유사도 검색. ADR-002 Phase 4 (유사도 엣지) 기반.
-- match_user_memories 와 동일한 OPERATOR(extensions.<=>) 패턴.
CREATE OR REPLACE FUNCTION public.match_weave_nodes(
  p_query_embedding extensions.vector(768),
  p_match_threshold float,
  p_match_count int,
  p_visibility text DEFAULT NULL,
  p_owner_user_id text DEFAULT NULL
)
RETURNS TABLE (
  node_id uuid,
  source_kind text,
  title text,
  body text,
  visibility text,
  owner_user_id text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    n.id,
    n.source_kind,
    n.title,
    n.body,
    n.visibility,
    n.owner_user_id,
    (1 - (emb.embedding OPERATOR(extensions.<=>) p_query_embedding))::float AS similarity
  FROM public.weave_node_embeddings emb
  JOIN public.weave_nodes n ON n.id = emb.node_id
  WHERE (p_visibility IS NULL OR n.visibility = p_visibility)
    AND (p_owner_user_id IS NULL OR n.owner_user_id = p_owner_user_id)
    AND (1 - (emb.embedding OPERATOR(extensions.<=>) p_query_embedding)) > p_match_threshold
  ORDER BY similarity DESC
  LIMIT p_match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_weave_nodes(extensions.vector(768), float, int, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_weave_nodes(extensions.vector(768), float, int, text, text) TO service_role;
