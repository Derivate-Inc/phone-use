/** Legacy text handlers retain their API; renderers must agree on explicit failures. */
export function toolFailed(result: string): boolean {
  return (
    /^(ERROR:|BLOCKED|⛔|⏸|✗|Could not|Tap failed|Fill failed|Search failed|Skill FAILED|type failed|Long-press failed|press failed|Scroll stopped)/.test(
      result,
    ) ||
    // Usage errors a handler reports as text ("tap needs label, ref, or
    // at={x,y}.", "batch action 2 is invalid — …"): nothing ran, so a script
    // must see a failure.
    /^[a-z_]+( [a-z]+)? needs /.test(result) ||
    /^batch action \d+ is invalid/.test(result) ||
    result.includes('\nStopped at action ')
  );
}
