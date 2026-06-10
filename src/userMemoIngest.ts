import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { embedMuelText } from './muelEmbeddings.js';
import { insertWeaveNode } from './weaveNodes.js';

/**
 * ADR-004 RI-3 — muel_user_memos 인박스 → muel_memory_entries 승격(ingest).
 *
 * propose_memo(#101) 의 [가르치기] 버튼과 Weave "알려주기" 가 사용자가 명시적으로 가르친 사실을
 * `muel_user_memos` 에 적재하지만, 회수(recall)는 `muel_memory_entries`(+embedding) 에서만 일어난다.
 * 그 사이가 끊겨 있어 가르친 메모가 인박스에만 쌓이고 다음 대화에 반영되지 않았다(루프 미완).
 *
 * 이 모듈이 그 마지막 고리를 닫는다: 미처리 user_memo 를 embedding 붙여 memory_entry 로 올리고
 * (ADR-002) weave user_memo 노드까지 만든 뒤 ingested_at 을 찍어 재처리를 막는다.
 *
 * 견고성: 절대 throw 하지 않는다(워커 루프를 막지 않음). 실패한 memo 는 ingested_at 을 찍지
 * 않으므로 다음 틱에서 자연스럽게 재시도된다(at-least-once).
 */

const BATCH = 5;

type PendingUserMemo = {
  id: string;
  discord_user_id: string;
  content: string;
};

export const ingestPendingUserMemos = async (supabase: SupabaseClient): Promise<number> => {
  let ingested = 0;
  try {
    const { data, error } = await supabase
      .from('muel_user_memos')
      .select('id, discord_user_id, content')
      .is('ingested_at', null)
      .order('created_at', { ascending: true })
      .limit(BATCH);
    if (error || !data || data.length === 0) return 0;

    for (const memo of data as PendingUserMemo[]) {
      try {
        const content = String(memo.content ?? '').trim();
        if (!content) {
          // 빈 내용 — 회수 가치 없음. 인박스에서만 마감(재처리 방지), 메모리로는 안 올림.
          await supabase
            .from('muel_user_memos')
            .update({ ingested_at: new Date().toISOString() })
            .eq('id', memo.id);
          continue;
        }

        const embedding = await embedMuelText(content);
        // 임베딩 미가용(키 없음/일시 실패) — ingested_at 안 찍고 다음 틱 재시도.
        if (!embedding) continue;

        // 사용자가 명시적으로 가르친 사실 = 높은 중요도(5). 인박스 출처라 chat/message 없음.
        const { data: newEntryId, error: insertError } = await supabase.rpc('insert_muel_memory_atomic', {
          p_chat_id: null,
          p_message_id: null,
          p_kind: 'preference',
          p_content: content,
          p_importance: 5,
          p_embedding: embedding,
          p_embedding_model: config.muelEmbeddingModel,
        });
        if (insertError) {
          console.warn('[user-memo-ingest] insert failed', insertError.message);
          continue; // 재시도
        }

        // ADR-002: weave 지식 노드(private, owner=사용자). 임베딩 재사용.
        void insertWeaveNode({
          sourceKind: 'user_memo',
          ownerUserId: memo.discord_user_id,
          body: content,
          sourceRef: {
            muel_user_memos_id: memo.id,
            muel_memory_entries_id: (newEntryId as string | null) ?? null,
            source: 'user_memo_ingest',
          },
          embedding,
        });

        await supabase
          .from('muel_user_memos')
          .update({
            ingested_at: new Date().toISOString(),
            ingested_entry_id: (newEntryId as string | null) ?? null,
          })
          .eq('id', memo.id);
        ingested += 1;
      } catch (err) {
        console.warn('[user-memo-ingest] memo failed', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn('[user-memo-ingest] poll failed', err instanceof Error ? err.message : String(err));
  }
  return ingested;
};
