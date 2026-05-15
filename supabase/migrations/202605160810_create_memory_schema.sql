-- 1. Create the core memory facts table
CREATE TABLE IF NOT EXISTS public.muel_memory_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_chat_id text NOT NULL, -- e.g. discord channel ID, or user ID for global context
    source_message_id uuid REFERENCES public.muel_messages_v2(id) ON DELETE SET NULL,
    topic text,
    content text NOT NULL,
    importance integer DEFAULT 1, -- 1-5 scale for pruning or weighting
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.muel_memory_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access to muel_memory_entries"
    ON public.muel_memory_entries
    FOR ALL
    USING (auth.role() = 'service_role');

-- 2. Create the embeddings table (one-to-one with entries)
CREATE TABLE IF NOT EXISTS public.muel_memory_embeddings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id uuid REFERENCES public.muel_memory_entries(id) ON DELETE CASCADE,
    embedding extensions.vector(1536) NOT NULL,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE public.muel_memory_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access to muel_memory_embeddings"
    ON public.muel_memory_embeddings
    FOR ALL
    USING (auth.role() = 'service_role');

-- 3. HNSW index for fast similarity search
CREATE INDEX IF NOT EXISTS muel_memory_embeddings_hnsw_idx 
    ON public.muel_memory_embeddings 
    USING hnsw (embedding extensions.vector_cosine_ops);

-- 4. Search RPC for retrieving relevant memories
CREATE OR REPLACE FUNCTION public.search_memory_entries(
    query_embedding extensions.vector(1536),
    match_threshold double precision DEFAULT 0.7,
    match_count int DEFAULT 5,
    filter_chat_id text DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    source_chat_id text,
    topic text,
    content text,
    importance integer,
    similarity double precision
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
    SELECT 
        e.id,
        e.source_chat_id,
        e.topic,
        e.content,
        e.importance,
        1 - (em.embedding <=> query_embedding) as similarity
    FROM public.muel_memory_embeddings em
    JOIN public.muel_memory_entries e ON e.id = em.memory_id
    WHERE 1 - (em.embedding <=> query_embedding) > match_threshold
        AND (filter_chat_id IS NULL OR e.source_chat_id = filter_chat_id)
    ORDER BY em.embedding <=> query_embedding
    LIMIT match_count;
$$;
