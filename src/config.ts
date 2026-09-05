const requiredEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const optionalEnv = (key: string): string | null => {
  return process.env[key]?.trim() || null;
};

const booleanEnv = (key: string, fallback: boolean): boolean => {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
};

const positiveIntegerEnv = (key: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[key]?.trim() ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export type DiscordComponentsV2Mode = 'off' | 'community' | 'cards';

const discordComponentsV2ModeEnv = (
  key: string,
  fallback: DiscordComponentsV2Mode,
): DiscordComponentsV2Mode => {
  const value = process.env[key]?.trim().toLowerCase();
  if (value === 'off' || value === 'community' || value === 'cards') return value;
  return fallback;
};

const youtubeWebSubCallbackUrl = (): string | null => {
  const explicit = optionalEnv('YOUTUBE_WEBSUB_CALLBACK_URL');
  if (explicit) return explicit;
  const renderExternalUrl = optionalEnv('RENDER_EXTERNAL_URL')?.replace(/\/+$/, '');
  return renderExternalUrl ? `${renderExternalUrl}/youtube/websub` : null;
};

// Gemini 3.6 Flash is the production baseline across generative lanes. Keeping
// one stable model here and in render.yaml prevents local/default behavior from
// drifting away from the deployed Blueprint values. MUEL_AI_MODEL and the
// lane-specific variables remain available for deliberate overrides.
const DEFAULT_LANE_MODEL = 'gemini-3.6-flash';
const DEFAULT_HEAVY_MODEL = 'gemini-3.6-flash';
const DEFAULT_VISION_MODEL = 'gemini-3.6-flash';

export const config = {
  discordBotToken: requiredEnv('DISCORD_BOT_TOKEN'),
  discordApplicationPublicKey: optionalEnv('DISCORD_APPLICATION_PUBLIC_KEY'),
  gomdoriBotToken: optionalEnv('GOMDORI_BOT_TOKEN'),
  gomdoriApplicationPublicKey: optionalEnv('GOMDORI_APPLICATION_PUBLIC_KEY'),
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: optionalEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: optionalEnv('SUPABASE_SERVICE_ROLE_KEY') ?? optionalEnv('SUPABASE_KEY'),
  googleGenerativeAiApiKey: optionalEnv('GOOGLE_GENERATIVE_AI_API_KEY') ?? optionalEnv('GEMINI_API_KEY'),
  muelAiModel: optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelChatModel: optionalEnv('MUEL_CHAT_MODEL') ?? optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelRouterModel: optionalEnv('MUEL_ROUTER_MODEL') ?? optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelExtractModel: optionalEnv('MUEL_EXTRACT_MODEL') ?? DEFAULT_HEAVY_MODEL,
  muelSummaryModel: optionalEnv('MUEL_SUMMARY_MODEL') ?? optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelHeavyModel: optionalEnv('MUEL_HEAVY_MODEL') ?? DEFAULT_HEAVY_MODEL,
  heavyProvider: (optionalEnv('MUEL_HEAVY_PROVIDER') ?? 'gemini') as 'gemini' | 'nvidia',
  muelVisionModel: optionalEnv('MUEL_VISION_MODEL') ?? DEFAULT_VISION_MODEL,
  muelEmbeddingModel: optionalEnv('MUEL_EMBEDDING_MODEL') ?? 'gemini-embedding-001',
  muelEmbeddingDimensions: Number(process.env.MUEL_EMBEDDING_DIMENSIONS ?? 768),
  nvidiaApiKey: optionalEnv('NVIDIA_API_KEY'),
  nvidiaModel: optionalEnv('NVIDIA_MODEL') ?? 'deepseek-ai/deepseek-v4-pro',
  mindlogicApiKey: optionalEnv('MINDLOGIC_API_KEY'),
  mindlogicModel: optionalEnv('MINDLOGIC_MODEL') ?? 'gemini-3.6-flash',
  // chat 레인 프로바이더 스위치 — 잡담/lightweight 턴의 소셜 캘리브레이션(반어·드립·답장 문맥)
  // 개선용. mindlogic 이면 chat 레인만 MindLogic 게이트웨이의 frontier 모델로 라우팅.
  chatProvider: (optionalEnv('MUEL_CHAT_PROVIDER') ?? 'gemini') as 'gemini' | 'mindlogic',
  mindlogicChatModel: optionalEnv('MINDLOGIC_CHAT_MODEL') ?? 'gpt-5.6-sol',
  // 부팅 시 프로바이더 도달성 프로브(muel_ai_events source='healthcheck'). 비용 무시 가능.
  enableProviderHealthcheck: booleanEnv('ENABLE_PROVIDER_HEALTHCHECK', true),
  // 후보 모델 실측용 추가 프로브: "provider:modelId" 콤마 목록 (예: "mindlogic:gpt-5.6-terra,nvidia:z-ai/glm-5.2").
  // 코드 변경 없이 env 만으로 신규 모델의 도달성·레이턴시를 healthcheck 텔레메트리로 잰다.
  probeExtraModels: optionalEnv('PROBE_EXTRA_MODELS'),
  // 소셜 골든셋 eval — 모델/프롬프트 변경 직후 한 부팅만 켜서 회귀 확인(기본 off).
  enableSocialEval: booleanEnv('ENABLE_SOCIAL_EVAL', false),
  // P4 social-read 전처리 — 잡담 턴 생성 전 저가 판독 1홉(수신자/레지스터/확신도).
  enableSocialRead: booleanEnv('MUEL_SOCIAL_READ', true),
  nvidiaHeavyModel: optionalEnv('NVIDIA_HEAVY_MODEL') ?? 'deepseek-ai/deepseek-v4-flash',
  hubUrl: optionalEnv('HUB_URL') ?? 'https://muel-tree.vercel.app',
  youtubeMonitorIntervalMs: Number(process.env.YOUTUBE_MONITOR_INTERVAL_MS ?? 5 * 60_000),
  youtubeFetchTimeoutMs: Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS ?? 20_000),
  youtubeMonitorConcurrency: positiveIntegerEnv('YOUTUBE_MONITOR_CONCURRENCY', 3),
  youtubeDataApiKey: optionalEnv('YOUTUBE_DATA_API_KEY'),
  // Community Posts still have no supported Data API resource. Product behavior
  // remains enabled, but it has an immediate kill switch because the experimental
  // HTML/InnerTube connector can change independently of Data API v3.
  youtubeCommunityEnabled: booleanEnv('YOUTUBE_COMMUNITY_ENABLED', true),
  // Shorts are a by-product of channel feeds, not a Muel delivery surface.
  youtubeSuppressShorts: booleanEnv('YOUTUBE_SUPPRESS_SHORTS', true),
  youtubeWebSubEnabled: booleanEnv('YOUTUBE_WEBSUB_ENABLED', true),
  youtubeWebSubCallbackUrl: youtubeWebSubCallbackUrl(),
  youtubeWebSubRenewIntervalMs: Number(
    process.env.YOUTUBE_WEBSUB_RENEW_INTERVAL_MS ?? 12 * 60 * 60_000,
  ),
  youtubeLifecycleIntervalMs: Number(
    process.env.YOUTUBE_LIFECYCLE_INTERVAL_MS ?? 24 * 60 * 60_000,
  ),
  mentionReplyTimeoutMs: Number(process.env.MENTION_REPLY_TIMEOUT_MS ?? 15_000),
  mentionImageReplyTimeoutMs: Number(process.env.MENTION_IMAGE_REPLY_TIMEOUT_MS ?? 35_000),
  // Components V2 rollout:
  // - off: legacy content/embed renderer only
  // - community: YouTube community cards only
  // - cards: community cards plus durable rich-card DMs (for example research results)
  // Interaction state machines remain legacy because the V2 message flag is irreversible.
  discordComponentsV2Mode: discordComponentsV2ModeEnv('DISCORD_COMPONENTS_V2', 'cards'),
  spamBlockEnabled: booleanEnv('MUEL_SPAM_BLOCK_ENABLED', true),
  spamBlockMinConfidence: Number(process.env.MUEL_SPAM_BLOCK_MIN_CONFIDENCE ?? 0.75),
  // 명시적 호출(mention/DM/reply/!muel) 경로 전용 상향 임계. 사용자가 일부러 부른
  // 메시지를 spam 오분류로 침묵시키는 비용이 커서(reflection 제안 07-10, 실제 침묵 2건)
  // 확실한 spam(>=0.95)만 차단한다.
  spamBlockMentionMinConfidence: Number(process.env.MUEL_SPAM_BLOCK_MENTION_MIN_CONFIDENCE ?? 0.95),
  enableJobWorker: booleanEnv('ENABLE_JOB_WORKER', booleanEnv('ENABLE_MEMORY_WORKER', true)),
  jobWorkerConcurrency: positiveIntegerEnv('JOB_WORKER_CONCURRENCY', 2),
  enableYoutubeMonitor: booleanEnv('ENABLE_YOUTUBE_MONITOR', true),
  enableHttpInteractions: booleanEnv('ENABLE_HTTP_INTERACTIONS', false),
  registerDiscordCommandsOnReady: booleanEnv('REGISTER_DISCORD_COMMANDS_ON_READY', false),
  // AI-Q research backend (GCP Cloud Run). When AIQ_SERVER_URL is unset, the
  // enrichment button responds with a "backend not configured" message and
  // does not enqueue a job.
  aiqServerUrl: optionalEnv('AIQ_SERVER_URL'),
  aiqAuthToken: optionalEnv('AIQ_AUTH_TOKEN'),
  aiqPollIntervalMs: Number(process.env.AIQ_POLL_INTERVAL_MS ?? 5_000),
  // deep_researcher (max_loops=2) takes ~15-20 min per the AI-Q deploy notes,
  // so the previous 10 min default was guaranteed to time out. Bumped to 45 min
  // (2700s); prod showed 25 min still timed out mid-run; shallow_researcher finishes
  // in ~30s-3min and is unaffected. Override with AIQ_POLL_TIMEOUT_MS env.
  aiqPollTimeoutMs: Number(process.env.AIQ_POLL_TIMEOUT_MS ?? 45 * 60_000),
  aiqDefaultAgentType: optionalEnv('AIQ_DEFAULT_AGENT_TYPE') ?? 'deep_researcher',
  aiqTopicMaxChars: Number(process.env.AIQ_TOPIC_MAX_CHARS ?? 2_000),
  aiqEnabled: booleanEnv('AIQ_ENABLED', true),
  // Operator-owned guild archival. OWNED_GUILD_ID is the feature switch: when
  // it is unset, every archivist handler is a no-op and existing deployments
  // keep their current behaviour.
  ownedGuildId: optionalEnv('OWNED_GUILD_ID'),
  archiveSalt: optionalEnv('ARCHIVE_SALT'),
  archiveEncKey: optionalEnv('ARCHIVE_ENC_KEY'),
  archivePolicyUrl: optionalEnv('ARCHIVE_POLICY_URL'),
  archivePersonalToken: optionalEnv('ARCHIVE_PERSONAL_TOKEN'),
  archiveBackfillEnabled: booleanEnv('ENABLE_ARCHIVE_BACKFILL', true),
  archiveAttachmentCopyIntervalMs: Number(process.env.ARCHIVE_ATTACHMENT_COPY_INTERVAL_MS ?? 30_000),
  ncpAccessKey: optionalEnv('NCP_ACCESS_KEY'),
  ncpSecretKey: optionalEnv('NCP_SECRET_KEY'),
  ncpObjectEndpoint: optionalEnv('NCP_OBJ_ENDPOINT') ?? 'https://kr.object.ncloudstorage.com',
  ncpObjectBucket: optionalEnv('NCP_OBJ_BUCKET') ?? 'muel-archive',
  // NAVER API HUB Search credentials are gateway keys, not NCP IAM/Object
  // Storage credentials. Keep them separate so a search tool can never gain
  // archive authority by accident.
  naverSearchEnabled: booleanEnv('NAVER_SEARCH_ENABLED', true),
  naverHubKeyId: optionalEnv('NAVER_HUB_KEY_ID'),
  naverHubKey: optionalEnv('NAVER_HUB_KEY'),
  naverSearchTimeoutMs: Number(process.env.NAVER_SEARCH_TIMEOUT_MS ?? 4_500),
};
