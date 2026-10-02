// Interest-group matching, shared by the watcher (new posts) and the explorer
// (re-scanning stored posts) so both apply exactly the same rules.
export function matchGroups(post, groups) {
  const matched = [];
  const authorLower = (post.author || '').toLowerCase();
  const captionLower = (post.caption || '').toLowerCase();

  for (const group of groups) {
    const reasons = [];

    const accounts = (group.accounts || []).map(acct => acct.toLowerCase().replace(/^@+/, '')).filter(Boolean);
    if (accounts.some(acct => authorLower.includes(acct))) {
      reasons.push(`account @${post.author}`);
    }

    const matchedKeywords = (group.keywords || []).filter(kw =>
      captionLower.includes(kw.toLowerCase())
    );
    if (matchedKeywords.length > 0) {
      reasons.push(`keyword "${matchedKeywords[0]}"`);
    }

    const matchedHashtags = (group.hashtags || []).filter(tag =>
      captionLower.includes(tag.toLowerCase())
    );
    if (matchedHashtags.length > 0) {
      reasons.push(`hashtag ${matchedHashtags[0]}`);
    }

    if (reasons.length > 0) {
      matched.push({ id: group.id, name: group.name, color: group.color || null, telegramThreadId: group.telegramThreadId || null, reasons });
    }
  }

  return matched;
}
