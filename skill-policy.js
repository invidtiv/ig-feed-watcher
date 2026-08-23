const FULL_AGENT_BLOCK =
  /<!-- FULL_AGENT_ONLY_START -->[\s\S]*?<!-- FULL_AGENT_ONLY_END -->\n?/g;

const READ_ONLY_DESCRIPTION =
  'description: Query the IG Feed Watcher feed database. Use when you need to read feeds, fetch an individual post with its image, list sources or groups, or export post metadata as JSON.';

export function skillForCapabilities(sourceSkill, { fullAgent }) {
  if (fullAgent) return sourceSkill;

  return sourceSkill
    .replace(FULL_AGENT_BLOCK, '')
    .replace(/^description:.*$/m, READ_ONLY_DESCRIPTION);
}
