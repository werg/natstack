export interface MentionDeliveryMessage {
  content: string;
  mentions: string[];
}

export function buildMentionDeliveryMessage(args: {
  path: string;
  mentions: string[];
  unifiedDiff: string;
}): MentionDeliveryMessage | null {
  const mentions = [...new Set(args.mentions)].filter(Boolean);
  if (mentions.length === 0) return null;
  const handles = mentions.map((handle) => `@${handle}`).join(" ");
  return {
    mentions,
    content: [
      `${handles} I just edited \`${args.path}\`. Diff:`,
      "```diff",
      args.unifiedDiff,
      "```",
    ].join("\n"),
  };
}
