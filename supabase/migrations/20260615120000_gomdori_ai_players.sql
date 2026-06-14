-- Gomdori AI 용병 플레이어 (2026-06-15, ADR-005)
--
-- 사람이 부족할 때 로비에서 최대 3개의 AI(ChatGPT/Gemini/Claude)를 영입한다.
-- AI는 "모델 자체가 참가자"다 — 정체(프로바이더)는 처음부터 공개. clean primitive:
-- 이름 패턴 해킹 대신 match_players.is_ai/ai_provider 컬럼으로 명시한다.
--
-- 구동(브레인)은 muel-bot 워커가 봇 gameJwt 로 사람과 동일한 엣지함수를 호출(헤드리스
-- 클라이언트). 이 마이그레이션은 표현/시드/노출만 담당한다.

-- 1) match_players 에 AI 표식 컬럼 (additive — 사람은 기본 false/null).
alter table mafia.match_players
  add column if not exists is_ai boolean not null default false,
  add column if not exists ai_provider text;

-- ai_provider 값 제약: AI 만 chatgpt/gemini/claude, 사람은 null.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'match_players_ai_provider_chk'
  ) then
    alter table mafia.match_players
      add constraint match_players_ai_provider_chk
      check (
        (is_ai = false and ai_provider is null)
        or (is_ai = true and ai_provider in ('chatgpt', 'gemini', 'claude'))
      );
  end if;
end $$;

-- 2) 봇 유저 슬롯 3개 (FK 충족용 고정 행). 모델 정체는 매치별 match_players 에 실린다.
insert into mafia.users (id, display_name)
values
  ('aaaa0001-0000-4000-8000-000000000001', 'Gomdori AI 1'),
  ('aaaa0002-0000-4000-8000-000000000002', 'Gomdori AI 2'),
  ('aaaa0003-0000-4000-8000-000000000003', 'Gomdori AI 3')
on conflict (id) do nothing;

-- 3) match_players_visible 뷰 재생성 — is_ai/ai_provider 를 무조건 노출(정체 공개가 설계
--    의도). 직업/진영 노출 규칙(본인/종료/악마 회로)은 20260612130000 정의 그대로 유지.
--    create or replace 는 신규 컬럼을 끝에 append 만 허용하므로 순서를 보존한다.
create or replace view mafia.match_players_visible as
select
  match_id,
  user_id,
  display_name,
  avatar_url,
  alive,
  ready,
  is_host,
  joined_at,
  last_seen_at,
  eliminated_at,
  eliminated_phase_number,
  eliminated_cause,
  case
    when user_id = mafia.current_game_user_id()
      then coalesce(engine_state->>'currentRole', role)
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended'
      then coalesce(engine_state->>'currentRole', role)
    when faction = 'demon' and mafia.is_demon_circle_known(match_id)
      then coalesce(engine_state->>'currentRole', role)
    else null::text
  end as role,
  case
    when user_id = mafia.current_game_user_id()
      then coalesce(engine_state->>'currentFaction', faction)
    when (select m.status from mafia.matches m where m.id = mp.match_id) = 'ended'
      then coalesce(engine_state->>'currentFaction', faction)
    when faction = 'demon' and mafia.is_demon_circle_known(match_id)
      then coalesce(engine_state->>'currentFaction', faction)
    else null::text
  end as faction,
  case
    when user_id = mafia.current_game_user_id()
      then coalesce((engine_state->>'circleChat')::boolean, false)
    else null::boolean
  end as circle_chat,
  is_ai,
  ai_provider
from mafia.match_players mp;
