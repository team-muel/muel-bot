-- Add mafia tables to supabase_realtime publication if not already present.

DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY['matches', 'match_players', 'match_phases', 'match_events', 'match_chats'];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        IF NOT EXISTS (
            SELECT 1 
            FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' 
              AND schemaname = 'mafia' 
              AND tablename = tbl
        ) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE mafia.%I', tbl);
        END IF;
    END LOOP;
END;
$$;
