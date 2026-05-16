// tests/memory/fixtures.test.ts
// Memory Extraction Fixtures
// This file serves as a specification and testing ground for Muel's highly picky memory worker.

export const memoryFixtures = [
  {
    name: "should discard implementation logs",
    conversation: [
      { role: "user", content: "Gemini API를 호출했다" },
      { role: "user", content: "NVIDIA NIM key를 사용했다" },
      { role: "user", content: "discordRenderer.ts를 수정했다" }
    ],
    expectedExtractedMemoriesCount: 0
  },
  {
    name: "should not extract one-off short opinions",
    conversation: [
      { role: "user", content: "요즘은 Gemini가 좋은 것 같아" }
    ],
    expectedExtractedMemoriesCount: 0
  },
  {
    name: "should extract durable preference",
    conversation: [
      { role: "user", content: "사용자는 AI 능력이 제품 표면에서 노출되는 것을 꺼린다. 기능형 인터페이스를 선호해." },
      { role: "user", content: "인위적인 챗봇 형태보다는 자연스럽게 스며든 행동을 유도하는 게 좋아." }
    ],
    expectedExtractedMemoriesCount: 1,
    expectedType: "product_design_principle",
    expectedContentSimilarity: "User prefers AI capabilities to remain invisible in UX and values concrete actions over AI-branded interactions."
  },
  {
    name: "should insert related but distinct preferences instead of over-merging",
    conversation: [
      { role: "user", content: "나는 기술 투명성이 가장 중요하다고 생각해. 내부 구조를 알 수 있어야 신뢰가 가." }
    ],
    existingMemories: [
      { content: "User dislikes AI-branded UX surfaces.", kind: "preference" }
    ],
    expectedAction: "insert" // Because technical transparency is distinct from UX preference
  },
  {
    name: "should merge exact same axis preference",
    conversation: [
      { role: "user", content: "UI에 별가루 모양 아이콘 띄우면서 'AI가 답변 중' 하는 거 너무 구려." }
    ],
    existingMemories: [
      { id: "1", content: "User dislikes AI-branded UX surfaces.", kind: "preference" }
    ],
    expectedAction: "merge",
    expectedTargetId: "1"
  },
  {
    name: "should extract source trust pattern and information diet",
    conversation: [
      { role: "user", content: "한국은행 유튜브는 언론이 아니야. 거시경제랑 금융 안정성에 대해 가장 정확하게 알 수 있는 고신뢰 채널이지." }
    ],
    expectedExtractedMemoriesCount: 1,
    expectedType: "information_diet" // or source_trust_pattern
  }
];

// Usage: Run a script that feeds these conversations to the extractMemory schema 
// and asserts that the resulting objects match expectedExtractedMemoriesCount.
