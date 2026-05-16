-- 20260516205723_add_memory_retrieval_indexes.sql
-- Reconstructed from the applied production migration history so local files match Supabase.

CREATE INDEX IF NOT EXISTS muel_chats_source_user_id_idx
ON public.muel_chats (source_user_id);

CREATE INDEX IF NOT EXISTS muel_memory_entries_status_idx
ON public.muel_memory_entries (status);

CREATE INDEX IF NOT EXISTS muel_memory_embeddings_vector_idx
ON public.muel_memory_embeddings
USING hnsw (embedding vector_cosine_ops);
