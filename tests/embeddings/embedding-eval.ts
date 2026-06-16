/**
 * Stage 4.4 — Embedding baseline evaluation.
 *
 * Establishes a measurable baseline for the current embedding configuration
 * (gemini-embedding-001, 768d). Run periodically and compare metrics to detect:
 *   - Provider-side quality regressions.
 *   - Schema/prompt changes elsewhere that degrade retrieval.
 *   - Unexpected dimension/value drift.
 *
 * Dataset structure (kept in this file so it diffs cleanly in git):
 *   - 12 anchor texts (preferences, memory fragments, project facts).
 *   - 1 paraphrase per anchor → positive pair, same meaning.
 *   - 1 adversarial near-miss per anchor → negative pair, similar topic/words,
 *     different meaning. The model should rank the paraphrase higher than the
 *     near-miss for that anchor.
 *
 * Metrics reported:
 *   - mean cosine similarity for positive pairs (higher is better).
 *   - mean cosine similarity for negative pairs (lower is better).
 *   - separation gap = mean(positive) - mean(negative).
 *   - recall@1 / recall@3 / recall@5: for each anchor, rank all other
 *     non-anchor entries by similarity. Did the matching paraphrase appear
 *     in the top K?
 *
 * Not modeled here (intentional): full RAG end-to-end (out of eval scope) and
 * the merge-vs-insert logic (that's structured-output testing, not embedding).
 *
 * Run:
 *   GOOGLE_GENERATIVE_AI_API_KEY=xxx DISCORD_BOT_TOKEN=dummy npx tsx tests/embeddings/embedding-eval.ts
 *
 * Optional env:
 *   MUEL_EMBEDDING_MODEL (default: gemini-embedding-001)
 *   MUEL_EMBEDDING_DIMENSIONS (default: 768)
 */

import { embedMuelText } from '../../src/muelEmbeddings.js';
import { config } from '../../src/config.js';

type EvalRow = {
  id: string;
  text: string;
  pairId: string; // shared with the matching paraphrase
  role: 'anchor' | 'paraphrase' | 'near_miss';
};

const dataset: EvalRow[] = [
  // 1. AI-invisible UX preference.
  { id: 'a1', pairId: 'p1', role: 'anchor', text: '사용자는 AI 기능이 제품 표면에 노출되는 것을 싫어한다. UX에서 AI가 보이지 않는 것을 선호한다.' },
  { id: 'p1', pairId: 'p1', role: 'paraphrase', text: '사용자는 "AI가 생성했어요" 같은 라벨이 노출되는 인터페이스를 거부하고, AI가 자연스럽게 동작하길 원한다.' },
  { id: 'n1', pairId: 'p1', role: 'near_miss', text: '사용자는 자신의 작업에 AI를 활용하는 것을 적극적으로 즐긴다. AI 기능이 강조된 UI를 좋아한다.' },

  // 2. Technical transparency value.
  { id: 'a2', pairId: 'p2', role: 'anchor', text: '사용자는 기술적 투명성을 가장 중요한 가치로 여긴다. 시스템 내부가 보여야 신뢰한다.' },
  { id: 'p2', pairId: 'p2', role: 'paraphrase', text: '사용자에게 신뢰는 black box 거부에서 온다. 내부 로직과 의사결정 경로가 드러나야 한다.' },
  { id: 'n2', pairId: 'p2', role: 'near_miss', text: '사용자는 효율을 중시하며, 내부 구조보다 결과에 더 관심이 있다.' },

  // 3. Hangik Bank YouTube channel as high-trust source.
  { id: 'a3', pairId: 'p3', role: 'anchor', text: '사용자는 한국은행 유튜브 채널을 거시경제 정보 출처로 신뢰한다.' },
  { id: 'p3', pairId: 'p3', role: 'paraphrase', text: '사용자에게 한국은행 공식 유튜브는 거시 흐름을 가장 정확히 알려주는 고신뢰 채널이다.' },
  { id: 'n3', pairId: 'p3', role: 'near_miss', text: '사용자는 일반 경제 유튜버의 분석에 의존하지 않으며, 모든 미디어를 의심한다.' },

  // 4. Equal relationship preference.
  { id: 'a4', pairId: 'p4', role: 'anchor', text: '사용자는 위계 없는 동등한 관계를 선호한다. 상하 관계 호칭을 피한다.' },
  { id: 'p4', pairId: 'p4', role: 'paraphrase', text: '사용자에게 가장 편한 대화 형태는 위아래가 없는 수평 관계다.' },
  { id: 'n4', pairId: 'p4', role: 'near_miss', text: '사용자는 명확한 권위 구조 안에서 일하는 것을 선호한다.' },

  // 5. Accountability discipline.
  { id: 'a5', pairId: 'p5', role: 'anchor', text: '사용자는 자신이 결정한 일에 대한 책임 구조를 중요하게 생각한다.' },
  { id: 'p5', pairId: 'p5', role: 'paraphrase', text: '사용자에게 의사결정은 책임이 따라야만 의미가 있다.' },
  { id: 'n5', pairId: 'p5', role: 'near_miss', text: '사용자는 책임 추궁을 피하기 위해 결정 자체를 유보하는 편이다.' },

  // 6. Dream — being chased in tunnel.
  { id: 'a6', pairId: 'p6', role: 'anchor', text: '꿈에서 어두운 터널 안을 누군가에게 쫓기며 달리고 있었다. 빠져나갈 출구가 보이지 않았다.' },
  { id: 'p6', pairId: 'p6', role: 'paraphrase', text: '컴컴한 굴 속을 추격자에게서 도망치며 뛰는 꿈. 끝이 보이지 않는 두려움이 있었다.' },
  { id: 'n6', pairId: 'p6', role: 'near_miss', text: '터널을 천천히 산책하다가 끝에서 빛을 보고 안도하는 꿈이었다.' },

  // 7. Dream — flying over city.
  { id: 'a7', pairId: 'p7', role: 'anchor', text: '도시 위를 자유롭게 날아다니는 꿈을 꿨다. 빌딩 사이를 부드럽게 통과했다.' },
  { id: 'p7', pairId: 'p7', role: 'paraphrase', text: '꿈에서 비행하며 도시 상공을 가로질렀다. 고층 건물 사이를 미끄러지듯 지나갔다.' },
  { id: 'n7', pairId: 'p7', role: 'near_miss', text: '꿈에서 무거운 짐을 들고 도시를 걸어 다녔다. 빌딩들이 너무 높게 느껴졌다.' },

  // 8. Project: Muel Discord bot scope.
  { id: 'a8', pairId: 'p8', role: 'anchor', text: 'Muel은 Discord 서버 안에서 동작하는 상주형 AI 컨시어지를 목표로 하는 봇이다.' },
  { id: 'p8', pairId: 'p8', role: 'paraphrase', text: 'Muel 프로젝트는 Discord 서버에 상주하면서 사용자 응대를 자동화하는 AI 봇을 만드는 일이다.' },
  { id: 'n8', pairId: 'p8', role: 'near_miss', text: 'Muel은 모바일 앱에서 동작하는 음성 비서 프로젝트다.' },

  // 9. Working style — system & structure thinker.
  { id: 'a9', pairId: 'p9', role: 'anchor', text: '사용자는 시스템과 구조 단위로 사고하며, 개별 사례보다 패턴을 본다.' },
  { id: 'p9', pairId: 'p9', role: 'paraphrase', text: '사용자의 기본 사고 단위는 구조다. 사례를 보면 그 뒤의 시스템을 추론한다.' },
  { id: 'n9', pairId: 'p9', role: 'near_miss', text: '사용자는 사례 중심으로 생각하며, 일반화나 구조화를 경계한다.' },

  // 10. Communication — no sycophancy.
  { id: 'a10', pairId: 'p10', role: 'anchor', text: '사용자는 sycophancy(아부)나 과도한 개인화를 싫어한다.' },
  { id: 'p10', pairId: 'p10', role: 'paraphrase', text: '사용자는 비위 맞추는 응대나 개인 친밀감을 일부러 만드는 응대를 거부한다.' },
  { id: 'n10', pairId: 'p10', role: 'near_miss', text: '사용자는 정중하고 친근한 응대 톤을 가장 선호한다.' },

  // 11. Information diet — distance with vested interest.
  { id: 'a11', pairId: 'p11', role: 'anchor', text: '사용자는 이해관계가 얽힌 정보원에 대해 거리를 둔다.' },
  { id: 'p11', pairId: 'p11', role: 'paraphrase', text: '사용자에게 vested interest가 있는 화자는 신호로서 가치가 낮다고 본다.' },
  { id: 'n11', pairId: 'p11', role: 'near_miss', text: '사용자는 이해관계가 있는 사람의 정보를 가장 깊이 있는 정보로 본다.' },

  // 12. Project — Weave memory correction surface.
  { id: 'a12', pairId: 'p12', role: 'anchor', text: 'Weave는 Muel이 사용자를 어떻게 기억하는지 보여주고 사용자가 맞음/틀림으로 교정하는 Activity다.' },
  { id: 'p12', pairId: 'p12', role: 'paraphrase', text: 'Weave는 Discord Activity로 작동하며 Muel의 사용자 기억을 확인하고 바로잡는 기억 교정 표면이다.' },
  { id: 'n12', pairId: 'p12', role: 'near_miss', text: 'Weave는 꿈 일기만 저장하는 별도 메모 앱이다.' },
];

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const mean = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const fmt = (n: number): string => n.toFixed(4);

const main = async () => {
  if (!config.googleGenerativeAiApiKey) {
    console.error('❌ Missing GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY. Embedding eval requires a live key.');
    process.exit(1);
  }
  console.log(`Embedding model: ${config.muelEmbeddingModel} @ ${config.muelEmbeddingDimensions}d`);
  console.log(`Dataset size: ${dataset.length} rows (${dataset.filter((r) => r.role === 'anchor').length} anchors)`);

  const embeddings = new Map<string, number[]>();
  for (const row of dataset) {
    const vec = await embedMuelText(row.text);
    if (!vec) {
      console.error(`❌ Failed to embed row ${row.id}`);
      process.exit(1);
    }
    embeddings.set(row.id, vec);
  }
  console.log(`Embedded ${embeddings.size}/${dataset.length} rows.`);

  // Positive pairs: anchor ↔ paraphrase (matching pairId).
  const positivePairs: Array<{ pairId: string; sim: number }> = [];
  // Negative pairs: anchor ↔ near_miss within same pairId.
  const intraNegatives: Array<{ pairId: string; sim: number }> = [];
  // Cross negatives: anchor ↔ unrelated paraphrase.
  const crossNegatives: number[] = [];

  for (const anchor of dataset.filter((r) => r.role === 'anchor')) {
    const paraphrase = dataset.find((r) => r.role === 'paraphrase' && r.pairId === anchor.pairId);
    const nearMiss = dataset.find((r) => r.role === 'near_miss' && r.pairId === anchor.pairId);
    const anchorVec = embeddings.get(anchor.id)!;
    if (paraphrase) {
      positivePairs.push({ pairId: anchor.pairId, sim: cosine(anchorVec, embeddings.get(paraphrase.id)!) });
    }
    if (nearMiss) {
      intraNegatives.push({ pairId: anchor.pairId, sim: cosine(anchorVec, embeddings.get(nearMiss.id)!) });
    }
    for (const other of dataset) {
      if (other.role !== 'paraphrase' || other.pairId === anchor.pairId) continue;
      crossNegatives.push(cosine(anchorVec, embeddings.get(other.id)!));
    }
  }

  const meanPos = mean(positivePairs.map((p) => p.sim));
  const meanIntraNeg = mean(intraNegatives.map((p) => p.sim));
  const meanCrossNeg = mean(crossNegatives);

  console.log('\n--- Pairwise similarity ---');
  console.log(`positive (anchor↔paraphrase, n=${positivePairs.length}): mean=${fmt(meanPos)} median=${fmt(median(positivePairs.map((p) => p.sim)))}`);
  console.log(`intra-pair negative (anchor↔near_miss, n=${intraNegatives.length}): mean=${fmt(meanIntraNeg)} median=${fmt(median(intraNegatives.map((p) => p.sim)))}`);
  console.log(`cross-anchor negative (anchor↔other paraphrase, n=${crossNegatives.length}): mean=${fmt(meanCrossNeg)} median=${fmt(median(crossNegatives))}`);
  console.log(`separation gap (positive - intra negative) = ${fmt(meanPos - meanIntraNeg)}`);
  console.log(`separation gap (positive - cross negative) = ${fmt(meanPos - meanCrossNeg)}`);

  // Per-anchor near-miss-beat: paraphrase sim > near_miss sim ?
  let nearMissBeats = 0;
  for (const anchor of dataset.filter((r) => r.role === 'anchor')) {
    const paraphrase = dataset.find((r) => r.role === 'paraphrase' && r.pairId === anchor.pairId);
    const nearMiss = dataset.find((r) => r.role === 'near_miss' && r.pairId === anchor.pairId);
    if (!paraphrase || !nearMiss) continue;
    const anchorVec = embeddings.get(anchor.id)!;
    const posSim = cosine(anchorVec, embeddings.get(paraphrase.id)!);
    const negSim = cosine(anchorVec, embeddings.get(nearMiss.id)!);
    if (posSim > negSim) nearMissBeats += 1;
  }
  console.log(`paraphrase > near_miss: ${nearMissBeats}/${positivePairs.length}`);

  // Recall@K: for each anchor, rank all non-anchor entries by similarity. Is the matching paraphrase in top K?
  const recallKs = [1, 3, 5];
  const recallHits = new Map<number, number>(recallKs.map((k) => [k, 0]));
  for (const anchor of dataset.filter((r) => r.role === 'anchor')) {
    const anchorVec = embeddings.get(anchor.id)!;
    const candidates = dataset
      .filter((r) => r.role !== 'anchor')
      .map((r) => ({ id: r.id, pairId: r.pairId, sim: cosine(anchorVec, embeddings.get(r.id)!) }))
      .sort((a, b) => b.sim - a.sim);
    for (const k of recallKs) {
      const topK = candidates.slice(0, k);
      if (topK.some((c) => c.pairId === anchor.pairId && c.id.startsWith('p'))) {
        recallHits.set(k, (recallHits.get(k) ?? 0) + 1);
      }
    }
  }
  console.log('\n--- Recall@K (anchor → matching paraphrase among all non-anchors) ---');
  for (const k of recallKs) {
    const hits = recallHits.get(k) ?? 0;
    const total = positivePairs.length;
    console.log(`recall@${k} = ${hits}/${total} = ${fmt(hits / total)}`);
  }

  // Quality gates — fail the run if metrics drop below baseline.
  const gates = {
    minMeanPositive: 0.75,
    maxMeanCrossNegative: 0.65,
    minSeparationGapVsCross: 0.05,
    minRecallAt5: 0.75,
  };

  let failed = 0;
  if (meanPos < gates.minMeanPositive) { console.log(`❌ mean positive ${fmt(meanPos)} below gate ${gates.minMeanPositive}`); failed += 1; }
  if (meanCrossNeg > gates.maxMeanCrossNegative) { console.log(`❌ mean cross negative ${fmt(meanCrossNeg)} above gate ${gates.maxMeanCrossNegative}`); failed += 1; }
  if (meanPos - meanCrossNeg < gates.minSeparationGapVsCross) { console.log(`❌ separation gap vs cross ${fmt(meanPos - meanCrossNeg)} below gate ${gates.minSeparationGapVsCross}`); failed += 1; }
  const recallAt5 = (recallHits.get(5) ?? 0) / positivePairs.length;
  if (recallAt5 < gates.minRecallAt5) { console.log(`❌ recall@5 ${fmt(recallAt5)} below gate ${gates.minRecallAt5}`); failed += 1; }

  if (failed > 0) {
    console.log(`\n${failed} gate(s) failed. Investigate before treating these embeddings as the working baseline.`);
    process.exit(1);
  }
  console.log('\n✅ All embedding quality gates passed.');
};

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
