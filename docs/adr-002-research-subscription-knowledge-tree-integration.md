# ADR-002: Research / Subscription → Weave Knowledge Tree 통합

**상태**: Proposed (2026-06-05)
**대상**: muel-bot · muel-tree · Supabase
**관련**: ADR-001 (BoW Activity 아키텍처), [PR muel-bot#37](https://github.com/team-muel/muel-bot/pull/37) (`/메모`), [PR muel-bot#38](https://github.com/team-muel/muel-bot/pull/38) (Weave positioning), [PR muel-tree#13](https://github.com/team-muel/muel-tree/pull/13) (services 톤)

## 배경

사용자 결정 (2026-06-05):

> 현재 Muel이 리서치하거나 구독하는 것들이 보여지는 자산으로 남지 않고 Supabase에 log로만 계속 적재되는 형식인데, 이를 Weave와 통합 — 시각화하여 후방에 남도록. muel bot과 muel tree를 둘 다 활용.

현재 흐름:

| 데이터 종류 | 발생 위치 | 현재 적재 | 사용자 노출 |
|---|---|---|---|
| AI-Q 리서치 리포트 | `researchDeliver.ts` 가 사용자 DM 전송 | `muel_research_jobs` (status, report_full, delivery_channel...) | DM 일회성. 시간 지나면 history 묻힘. |
| YouTube 구독 알림 | `youtubeMonitor.ts` → `discordRenderer` | `muel_video_signals`, `muel_subscription_*` | 채널 임베드 1회 게시 후 message history 에 묻힘. |
| 자동 추출 메모 | `memoryWorker.ts` | `muel_memory_entries` | retrieveRelevantMemories 가 *대화 시 prompt 주입* 만. UI 0. |
| 사용자 직접 메모 | `/메모 add` (PR #37) | `muel_user_memos` | `/메모 목록` 카드 (개인 ephemeral). |
| 꿈 기록 (Weave 기존) | `/weave` Activity | `muel_dreams` + 임베딩 | `/weave` 시각화 그래프 노출. |

문제: AI-Q 리포트와 구독 알림이 *발생 시점에만* 사용자에게 도달하고 *후방 자산* 으로 안 남음. Weave 의 *기록 → 시각화 그래프* 패턴이 이미 있는데 *별개 데이터 사일로*.

Weave 의 positioning 도 변경됨 (PR #38, #13): *제품* 이 아니라 *여러분이 가꾸어 나가는 지식의 나무, 커뮤니티 특수 나무위키, Muel 이 보조*. 이 변경된 정체성에 *리서치/구독* 도 자연스럽게 흡수.

## 결정

### 1. Weave 데이터 모델을 *멀티 소스 지식 노드* 로 확장

기존 `muel_dreams` 가 *꿈 기록* 1종에 묶여 있던 것을 *Weave 노드* 로 일반화. 새 또는 변경된 테이블 (제안):

```sql
CREATE TABLE public.weave_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN (
    'dream',              -- 기존 꿈 기록 (마이그레이션)
    'research_report',    -- AI-Q 리포트
    'subscription_signal',-- YouTube 영상/게시글 알림
    'user_memo',          -- /메모 add 직접
    'auto_memo'           -- memoryWorker 자동 추출
  )),
  owner_user_id text NULL,    -- 사적 노드면 채워짐, 커뮤니티 공유면 NULL
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'community')),
  title text NULL,
  body text NOT NULL,
  tags text[] DEFAULT '{}',
  source_ref jsonb DEFAULT '{}',   -- 원본 참조 (research job id / subscription signal id / etc)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.weave_node_embeddings (
  node_id uuid PRIMARY KEY REFERENCES public.weave_nodes(id) ON DELETE CASCADE,
  embedding extensions.vector(768) NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX weave_nodes_visibility_created_idx ON public.weave_nodes(visibility, created_at DESC);
CREATE INDEX weave_nodes_owner_created_idx ON public.weave_nodes(owner_user_id, created_at DESC);
CREATE INDEX weave_nodes_source_kind_idx ON public.weave_nodes(source_kind);
```

기존 `muel_dreams` 는 *backfill migration* 으로 `weave_nodes` 에 `source_kind='dream'` 으로 복제. 신규 데이터부터는 `weave_nodes` 단일.

### 2. Producer (muel-bot 측)

각 데이터 종류 발생 시 *동시에* `weave_nodes` insert.

- **AI-Q 리포트 완료** (`researchDeliver.ts` SUCCESS 분기):
  ```ts
  await insertWeaveNode({
    source_kind: 'research_report',
    owner_user_id: payload.requesterUserId,
    visibility: 'private',  // 리포트는 기본 사적
    title: payload.topic,
    body: report.report,
    tags: extractTagsFromReport(report.report),  // ai 또는 정적 추출
    source_ref: { research_job_id: rowId, source_cited: sourceCited },
  });
  ```

- **YouTube 구독 신호** (`youtubeMonitor` → `videoRenderer` 직후):
  ```ts
  await insertWeaveNode({
    source_kind: 'subscription_signal',
    owner_user_id: null,
    visibility: 'community',  // 구독은 커뮤니티 공유
    title: video.title,
    body: video.summary ?? video.title,
    tags: [video.channel_name, video.kind],
    source_ref: { video_id: video.id, channel_id: video.channel_id, url: video.url },
  });
  ```

- **사용자 직접 메모** (`/메모 add`):
  ```ts
  await insertWeaveNode({
    source_kind: 'user_memo',
    owner_user_id: discordUserId,
    visibility: 'private',
    body: content,
    source_ref: { muel_user_memos_id: memoId },
  });
  ```

- **자동 추출 메모** (`memoryWorker`):
  ```ts
  await insertWeaveNode({
    source_kind: 'auto_memo',
    owner_user_id: chat.source_user_id,
    visibility: 'private',
    body: memory.content,
    tags: [memory.kind, memory.memory_type],
    source_ref: { muel_memory_entries_id: id, importance: memory.importance },
  });
  ```

각 producer 는 *fire-and-forget* — weave insert 실패해도 원래 경로 차단 X.

### 3. Consumer (muel-tree 측)

기존 `/weave` 의 *꿈 그래프* 가 *멀티 소스 노드 그래프* 로 확장:

- 노드 종류별 *시각 어휘* 분리:
  - `dream` — 기존 색 (purple/pink gradient).
  - `research_report` — 푸른 톤 + 책 아이콘.
  - `subscription_signal` — 영상/게시글 아이콘 + 출처 채널 색.
  - `user_memo` — 사용자 직접 (✏️ 직접) 아이콘.
  - `auto_memo` — Muel 추출 (🤖) 아이콘.
- 사용자 본인 ↔ 커뮤니티 공유 토글.
- 노드 클릭 → 패널에 `body` + `source_ref` 의 원본 링크 (있으면 jump).

### 4. 시각화 그래프 — 임베딩 유사도 엣지

기존 `muel_dreams` 가 임베딩 유사도로 연결되던 패턴 그대로. `weave_nodes` 도 임베딩 → 유사 노드 간 엣지 (Cosine threshold ~0.75).

→ 서로 다른 source_kind 가 자연스럽게 연결: *동일 주제의 리서치 리포트 + 구독 영상 + 메모* 가 한 *지식의 가지* 로 묶임.

### 5. 권한 / 가시성

- `visibility='private'` 노드는 *owner 본인 + service_role* 만 read. RLS 정책으로 강제.
- `visibility='community'` 노드는 길드 멤버 모두 read.
- 사용자가 `/메모 add` 시 기본 *private* 이지만, *"커뮤니티에 공유"* 옵션 추가 가능 (Phase 2).

## 트레이드오프

### 채택안의 장점
- 단일 모델 `weave_nodes` 가 *모든 지식 자산* 의 source. 향후 새 종류 (예: 검색 결과, 외부 RSS) 추가 시 `source_kind` 만 늘림.
- *후방 자산* 으로 남음 — DM 일회성 / 채널 묻힘 문제 해결.
- *시각화 그래프* 가 사용자에게 "내가 Muel과 함께 쌓은 지식" 의 visible 자산 제공.
- Weave 의 새 positioning ("여러분이 가꾸어 나가는 지식의 나무") 과 정합.

### 트레이드오프
- *모든 데이터를 weave_nodes 에 중복* — `muel_research_jobs` 등 기존 테이블과 함께 보존. *consistency burden* (origin 변경 시 weave node 도 update).
- *임베딩 비용 증가* — 모든 노드에 임베딩. 자동 메모는 이미 임베딩 있음, 구독 신호/리서치 리포트는 *새로 계산* 필요.
- *visibility policy* 의 RLS 가 까다로움 — Discord 멤버십을 어떻게 RLS 에서 검증?

## 거부된 대안

### 옵션 A: 각 데이터 종류마다 별도 *view* 만들고 frontend 가 union
- 거부 이유: 임베딩 유사도 엣지가 *서로 다른 테이블 간*에 어려움. 단일 그래프 시각화 복잡.

### 옵션 B: `muel_dreams` 에 source_kind 컬럼 추가하고 그대로 다 욱여넣기
- 거부 이유: 의미적으로 `muel_dreams` 는 *꿈 기록* 정체성. *지식의 나무 노드* 정체성으로 의미 확장이 자연스럽지 않음. 새 이름 `weave_nodes` 가 명확.

### 옵션 C: 기존 시스템 유지, 시각화만 *별도 read-only dashboard*
- 거부 이유: *사용자가 가꾸는* 모델이 아닌 *Muel 이 보여주는 reports* 가 됨. 사용자 결정 "여러분이 가꾸어 나가는 지식의 나무" 와 불일치.

## 단계적 구현

### Phase 1 — 데이터 모델 + 사용자 직접 메모 노드화
- migration: `weave_nodes` + `weave_node_embeddings` 생성, RLS policy.
- producer (muel-bot): `/메모 add` 시 `weave_nodes` 에도 insert (`source_kind='user_memo'`).
- 기존 `muel_dreams` backfill (script).
- consumer (muel-tree): `/weave` 가 `muel_dreams` 외에 `weave_nodes` 도 read. source_kind 별 아이콘.

### Phase 2 — 자동 메모 + 구독 신호 노드화
- producer: `memoryWorker.ts` SUCCESS 시 weave node insert. `youtubeMonitor` 발행 시도 동시 insert.
- consumer: 노드 종류 필터 토글 UI.

### Phase 3 — AI-Q 리포트 노드화
- producer: `researchDeliver.ts` SUCCESS 시 insert.
- consumer: 리포트 노드 클릭 시 *full report* 펼쳐보기 패널.

### Phase 4 — 임베딩 유사도 엣지 정착 + 커뮤니티 공유 토글
- 임베딩 RPC `match_weave_nodes` 신규.
- 엣지 계산 cron 또는 on-write.
- `/메모 add --share` 옵션으로 visibility=community 노드 생성.

### Phase 5 — Muel 의 "내 나무" UI
- 사용자 본인 시점의 그래프 view.
- *오늘 자란 가지* / *최근 7일* / *내가 직접 심은 것 vs Muel 이 심어준 것* 필터.

## 책임 분담

- **Claude**: ADR + Phase 1 데이터 모델 + producer (`/메모`) + consumer (`/weave`) view 확장.
- **Codex**: migration + RPC 임베딩 검색 + 백필 스크립트.
- **사용자**: 룰 결정 (visibility default, 노드 종류 추가/제거 정책) + 디자인 검토.

## 환경 변수

- 새로 추가 X — 기존 SUPABASE / GEMINI / AIQ 설정 그대로 활용.

## 위험 + 모니터링

- 임베딩 비용 모니터링 — Phase 2 이후 *구독 신호 폭증* 시 임베딩 호출 한도 주의.
- 사용자 직접 메모가 *그래프에 노출되는* 점 — `visibility='private'` 기본, RLS 강제. 사용자가 명시적으로 공유한 것만 community.
- AI-Q 리포트의 민감 정보 — full body 가 weave_nodes 에 저장됨. 사용자 본인 한정 visibility 기본.

## 변경 이력

- 2026-06-05: 초안. 사용자 결정 (리서치/구독 자산화 + Weave 통합) 반영.
