// AI 용병 의사결정 — MindLogic 게이트웨이(OpenAI 호환) 호출(ADR-005).
// 키/모델이 없거나 호출이 실패하면 ok:false 를 반환한다 → 호출부가 합법 휴리스틱으로
// 폴백한다. 따라서 MindLogic 가 없어도 게임은 정상적으로 완주된다(LLM 은 enhancement).

const MINDLOGIC_BASE = "https://factchat-cloud.mindlogic.ai/v1/gateway";

// 페르소나 → MindLogic 모델 id. env 로 교체 가능(ADR-005). 기본값은 합리적 추정 —
// 특히 ChatGPT id 는 .env 로 확정 필요. 미설정 시 MINDLOGIC_MODEL → 페르소나 기본.
const MODEL_ENV: Record<string, string> = {
  chatgpt: "GOMDORI_AI_MODEL_CHATGPT",
  gemini: "GOMDORI_AI_MODEL_GEMINI",
  claude: "GOMDORI_AI_MODEL_CLAUDE",
};
const DEFAULT_MODEL: Record<string, string> = {
  chatgpt: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
  claude: "claude-sonnet",
};

function modelFor(provider: string): string {
  const envKey = MODEL_ENV[provider];
  return (
    (envKey ? Deno.env.get(envKey) : null) ??
    Deno.env.get("MINDLOGIC_MODEL") ??
    DEFAULT_MODEL[provider] ??
    "gemini-2.5-flash"
  );
}

export type DecideResult = { ok: false } | { ok: true; choice: string | null };

export type DecideOptions = {
  provider: string;
  /** 자기 정체·상황 요약(시스템 힌트). */
  systemHint: string;
  /** 무엇을 고를지에 대한 질문. */
  question: string;
  /** 후보 — id(대상 userId 또는 토큰) + 사람이 읽는 라벨. */
  candidates: { id: string; label: string }[];
  /** true 면 기권(아무도 안 고름)을 허용. */
  allowSkip: boolean;
};

/**
 * 후보 중 하나를 LLM 으로 고른다. 반환:
 *   { ok: false }                 → LLM 불가/실패 (호출부 휴리스틱)
 *   { ok: true, choice: id }      → 그 후보 선택
 *   { ok: true, choice: null }    → 기권(allowSkip 일 때만)
 */
export async function decideChoice(opts: DecideOptions): Promise<DecideResult> {
  const key = Deno.env.get("MINDLOGIC_API_KEY");
  if (!key || opts.candidates.length === 0) return { ok: false };

  const numbered = opts.candidates.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
  const skipLine = opts.allowSkip ? `\n0. 기권(아무도 고르지 않음)` : "";
  const system =
    "너는 한국어 마피아 게임 'Gomdori'의 플레이어다. 주어진 정체와 상황에 맞게 전략적으로 한 가지를 고른다. " +
    "반드시 보기 번호 하나만 정수로 답한다. 다른 말은 하지 않는다.";
  const user =
    `${opts.systemHint}\n\n${opts.question}\n보기:\n${numbered}${skipLine}\n\n` +
    `답: 번호만(예: 2). ${opts.allowSkip ? "기권은 0." : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${MINDLOGIC_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: modelFor(opts.provider),
        temperature: 0.7,
        max_tokens: 8,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    const m = text.match(/-?\d+/);
    if (!m) return { ok: false };
    const n = parseInt(m[0], 10);
    if (opts.allowSkip && n === 0) return { ok: true, choice: null };
    if (n >= 1 && n <= opts.candidates.length) {
      return { ok: true, choice: opts.candidates[n - 1].id };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
