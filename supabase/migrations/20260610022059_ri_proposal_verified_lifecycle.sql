
-- 방법론 B-2: proposal lifecycle 에 verified 단계 명시.
-- pending → accepted → applied(머지) → verified(다음 run이 지표 이동 확인) → closed.
-- decision 은 free text 라 값만 추가 사용. 코멘트로 규약 박음.
comment on column muel_reflection_proposals.decision is
  'pending | accepted | rejected | applied | verified | closed. applied=머지됨(고쳐졌다 아님). verified=후속 run이 exhaust 지표 이동을 확인. "머지≠고쳐짐"을 구조로 강제.';

-- 아직 닫히지 않은(검증 안 된) 제안 = 항상 보이는 작업 큐. 주간 합성이 읽는다.
create or replace view v_open_proposals as
select p.id, p.run_id, r.kind as run_kind, p.type, p.title, p.decision,
       p.created_at, p.decided_at, r.created_at as run_at
from muel_reflection_proposals p
join muel_reflection_runs r on r.id = p.run_id
where p.decision not in ('verified','rejected','closed')
order by p.created_at;

alter view v_open_proposals set (security_invoker = on);
;
