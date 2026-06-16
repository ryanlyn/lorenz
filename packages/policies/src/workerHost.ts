export interface WorkerHostSelectionInput {
  hosts: string[];
  runningCounts: Map<string, number>;
  cap: number;
  preferredHost?: string | null | undefined;
}

export function selectLeastLoadedHost(input: WorkerHostSelectionInput): string | null | undefined {
  if (input.hosts.length === 0) return null;
  if (
    input.preferredHost &&
    input.hosts.includes(input.preferredHost) &&
    (input.runningCounts.get(input.preferredHost) ?? 0) < input.cap
  ) {
    return input.preferredHost;
  }
  let selected: string | null = null;
  let selectedCount = Number.POSITIVE_INFINITY;
  for (const host of input.hosts) {
    const count = input.runningCounts.get(host) ?? 0;
    if (count < input.cap && count < selectedCount) {
      selected = host;
      selectedCount = count;
    }
  }
  return selected ?? undefined;
}
