import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabase.js';
import { embedMuelText } from './muelEmbeddings.js';
import { config } from './config.js';

/**
 * weaveNodes — ADR-002 producer 측 단일 진입점.
 *
 * AI-Q 리서치 리포트 / YouTube 구독 신호 / 사용자·자동 메모가 발생할 때
 * 동시에 `weave_nodes` 에 멀티소스 지식 노드로 적재한다. muel-tree `/weave` 가
 * 이 테이블을 그래프/피드로 시각화해 "사용자가 가꾸어 나가는 지식의 나무" 로 노출.
 *
 * 모든 호출은 *fire-and-forget* — 임베딩/insert 실패가 원래 경로(DM 전송, 카드
 * 게시, 메모 저장)를 절대 막지 않는다. 호출부는 `void insertWeaveNode(...)` 로 쓴다.
 */

export type WeaveSourceKind =
  | 'dream'
  | 'research_report'
  | 'subscription_signal'
  | 'community_video'
  | 'community_post'
  | 'user_memo'
  | 'auto_memo';

export type WeaveVisibility = 'private' | 'community';

export type InsertWeaveNodeInput = {
  sourceKind: WeaveSourceKind;
  body: string;
  ownerUserId?: string | null;
  /** 미지정 시 sourceKind 별 기본값 (DEFAULT_VISIBILITY). */
  visibility?: WeaveVisibility;
  title?: string | null;
  tags?: string[];
  sourceRef?: Record<string, unknown>;
  /** 이미 계산된 임베딩 (예: memoryWorker). 없으면 helper 가 body 로 계산. */
  embedding?: number[] | null;
  client?: SupabaseClient;
};

export type DeleteWeaveNodesBySourceRefInput = {
  sourceKind: WeaveSourceKind;
  ownerUserId?: string | null;
  sourceRef: Record<string, unknown>;
  client?: SupabaseClient;
};

/** sourceKind 별 visibility 기본값 (ADR-002 두 페르소나: 개인 ↔ 커뮤니티). */
const DEFAULT_VISIBILITY: Record<WeaveSourceKind, WeaveVisibility> = {
  dream: 'private',
  research_report: 'private',
  subscription_signal: 'community',
  community_video: 'community',
  community_post: 'community',
  user_memo: 'private',
  auto_memo: 'private',
};

const MAX_BODY = 8000;
const MAX_TAGS = 12;

/**
 * weave_nodes 에 노드 1개 (+ 임베딩) 적재. 성공 시 node id, 실패/스킵 시 null.
 * 절대 throw 하지 않는다.
 */
export const insertWeaveNode = async (input: InsertWeaveNodeInput): Promise<string | null> => {
  const body = input.body?.trim();
  if (!body) return null;

  try {
    const supabase = input.client ?? getSupabaseClient();

    let embedding: number[] | null = input.embedding ?? null;
    if (!embedding) {
      try {
        embedding = await embedMuelText(body);
      } catch (err) {
        // 임베딩 실패해도 노드 자체는 남긴다 (유사도 엣지만 빠짐).
        console.warn('[weave] embed failed; inserting node without embedding', err);
        embedding = null;
      }
    }

    const tags = (input.tags ?? [])
      .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
      .filter(Boolean)
      .slice(0, MAX_TAGS);

    const { data, error } = await supabase.rpc('insert_weave_node', {
      p_source_kind: input.sourceKind,
      p_owner_user_id: input.ownerUserId ?? null,
      p_visibility: input.visibility ?? DEFAULT_VISIBILITY[input.sourceKind],
      p_title: input.title?.slice(0, 300) ?? null,
      p_body: body.slice(0, MAX_BODY),
      p_tags: tags,
      p_source_ref: input.sourceRef ?? {},
      p_embedding: embedding,
      p_embedding_model: embedding ? config.muelEmbeddingModel : null,
    });

    if (error) {
      console.warn('[weave] insert_weave_node failed', error.message);
      return null;
    }
    return typeof data === 'string' ? data : null;
  } catch (err) {
    console.warn('[weave] insertWeaveNode unexpected error', err);
    return null;
  }
};

/**
 * 원본 메모/리서치 항목이 삭제·비활성화될 때 연결된 private weave 노드를 같이 정리.
 * 실패해도 원래 사용자 액션은 막지 않는다.
 */
export const deleteWeaveNodesBySourceRef = async (input: DeleteWeaveNodesBySourceRefInput): Promise<void> => {
  try {
    const supabase = input.client ?? getSupabaseClient();
    let query = supabase
      .from('weave_nodes')
      .delete()
      .eq('source_kind', input.sourceKind)
      .contains('source_ref', input.sourceRef);

    if (input.ownerUserId) {
      query = query.eq('owner_user_id', input.ownerUserId);
    }

    const { error } = await query;
    if (error) {
      console.warn('[weave] delete by source_ref failed', error.message);
    }
  } catch (err) {
    console.warn('[weave] deleteWeaveNodesBySourceRef unexpected error', err);
  }
};
