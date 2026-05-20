export interface WorkerHostSelectionInput {
  hosts: string[];
  runningCounts: Map<string, number>;
  cap: number;
}

export function selectLeastLoadedHost(input: WorkerHostSelectionInput): string | null | undefined {
  if (input.hosts.length === 0) return null;
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
