export const DISCORD_LIMITS = {
  content: 1900,
  embedTitle: 256,
  embedDescription: 3900,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooter: 2048,
  buttonLabel: 80,
  customId: 100,
  selectPlaceholder: 150,
  selectOptionLabel: 100,
  selectOptionValue: 100,
  selectOptionDescription: 100,
  url: 512,
  componentsPerMessage: 5,
  buttonsPerRow: 5,
  selectOptions: 25,
  embedFields: 25,
} as const;

export const DISCORD_SAFE = {
  textContent: 1800,
  infoDescription: 3600,
  richDescription: 3000,
  communityBodyWithImage: 1400,
  communityBodyNoImage: 2400,
  sectionFieldValue: 960,
  title: 240,
  footer: 1800,
  quickResearchPreview: 1600,
  researchIntro: 1400,
} as const;

export type TruncateOptions = {
  omission?: string;
};

export type TruncateResult = {
  text: string;
  truncated: boolean;
};

export const truncateForDiscord = (
  text: string | null | undefined,
  max: number,
  options: TruncateOptions = {},
): TruncateResult => {
  const raw = text ?? '';
  if (raw.length <= max) return { text: raw, truncated: false };

  const omission = options.omission ?? '\n\n[일부 생략됨]';
  const room = Math.max(1, max - omission.length);
  return {
    text: `${raw.slice(0, room).trimEnd()}${omission}`,
    truncated: true,
  };
};

export const truncateDiscordText = (
  text: string | null | undefined,
  max: number,
  options: TruncateOptions = {},
): string => truncateForDiscord(text, max, options).text;
