/** Legacy text handlers retain their API; renderers must agree on explicit failures. */
export function toolFailed(result: string): boolean {
  return (
    /^(ERROR:|BLOCKED|⛔|⏸|✗|Could not|Tap failed|Fill failed|Search failed|Skill FAILED|type failed)/.test(
      result,
    ) || result.includes('\nStopped at action ')
  );
}
