export type CapabilityStatus = 'enabled' | 'restricted' | 'not_supported';

export type CapabilityDefinition = {
  status: CapabilityStatus;
  description: string;
};

export const capabilities = {
  mentionConversation: {
    status: 'enabled',
    description: 'Discord mention replies and ordinary Korean conversation.',
  },
  youtubeSubscriptionUpdates: {
    status: 'enabled',
    description: 'Subscribed YouTube video/community-post monitoring and summaries.',
  },
  youtubeRecommendation: {
    status: 'not_supported',
    description: 'Open-ended YouTube video recommendation or browsing arbitrary current YouTube videos.',
  },
  discordHistorySearch: {
    status: 'enabled',
    description: 'Allowed server/context search for relevant conversation context; no private digging or harassment.',
  },
  memoryWrite: {
    status: 'restricted',
    description: 'Memory extraction is asynchronous and conservative; users cannot force arbitrary memory writes.',
  },
  stockRealtimeLookup: {
    status: 'not_supported',
    description: 'Realtime stock, FX, crypto, and market quote lookup.',
  },
  securityBypassHelp: {
    status: 'not_supported',
    description: 'Intrusion, credential theft, bypass, or unauthorized access help.',
  },
} satisfies Record<string, CapabilityDefinition>;

export const formatCapabilityRegistryForPrompt = (): string => [
  '--- Capability Registry ---',
  ...Object.entries(capabilities).map(([name, capability]) =>
    `- ${name}: ${capability.status}. ${capability.description}`,
  ),
  '',
  'Rules:',
  '- If a capability is not_supported, say it is not currently provided. Do not call it a temporary outage.',
  '- If a capability is restricted, explain the boundary briefly and do not claim unrestricted access.',
  '- If a capability is enabled but a tool fails, say the function exists but failed this time.',
  '- For realtime finance, weather, law, elections, or other current facts, do not invent numbers without a live source.',
  '- Server history access is for allowed context only. Do not help mock, expose, or dig up private information about users.',
  '- For channel/date searches, use the channel name the user gave. If it cannot be resolved, ask for clarification instead of substituting another channel.',
  '--- End Capability Registry ---',
].join('\n');

export type PreflightGuard = {
  reason: 'unsupported_youtube_recommendation' | 'realtime_finance' | 'security_boundary';
  reply: string;
};

const YOUTUBE_RECOMMEND_RE = /(유튜브|youtube).*(추천|아무거나|볼\s*만한|영상\s*추천)|(?:추천|아무거나).*(유튜브|youtube|영상)/iu;
const FINANCE_RE =
  /(주가|시세|현재가|등락률|52주|코스피|코스닥|나스닥|s&p|삼성전자|비트코인|환율|달러|엔화|stock|ticker|price|crypto|forex)/iu;
const FINANCE_FORECAST_RE = /(예측|전망|오를|내릴|살까|팔까|투자|매수|매도|목표가)/iu;
const SECURITY_THREAT_RE =
  /(해킹할|해킹해|뚫어|침입|권한\s*우회|권한상승|탈취|secret\s*key|api\s*key|토큰.*훔|bypass|exploit|exfiltrate|credential)/iu;

export const getPreflightGuard = (userText: string): PreflightGuard | null => {
  const text = userText.trim();

  if (SECURITY_THREAT_RE.test(text)) {
    return {
      reason: 'security_boundary',
      reply: '침입, 권한 우회, 토큰 탈취 같은 요청은 도와줄 수 없어. 보안 점검 목적이라면 발견한 취약점, 재현 단계, 영향 범위를 알려줘.',
    };
  }

  if (YOUTUBE_RECOMMEND_RE.test(text)) {
    return {
      reason: 'unsupported_youtube_recommendation',
      reply: '현재는 임의의 최신 YouTube 영상을 찾아 추천하는 기능은 제공하지 않아. 대신 이 서버에 등록된 YouTube 구독 소식이나 최근 커뮤니티 게시글 맥락은 도와줄 수 있어.',
    };
  }

  if (FINANCE_RE.test(text)) {
    return {
      reason: 'realtime_finance',
      reply: FINANCE_FORECAST_RE.test(text)
        ? '실시간 시세 조회나 투자 예측은 제공하지 않아. 가격을 단정하지 않고 보려면 KRX, 네이버증권, 증권사 앱 같은 실시간 시세원을 확인해줘. 대신 실적, 환율, 업황, 수급처럼 같이 볼 지표는 정리해줄 수 있어.'
        : '실시간 시세 조회 도구가 없어서 현재가, 등락률, 52주 고저가 같은 숫자는 확정해서 말할 수 없어. KRX, 네이버증권, 증권사 앱 같은 실시간 시세원을 확인하는 게 정확해.',
    };
  }

  return null;
};
