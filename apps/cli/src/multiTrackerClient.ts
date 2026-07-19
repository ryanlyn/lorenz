import {
  parseScopedTrackerIssueId,
  scopedTrackerIssueId,
  type Issue,
  type RuntimeTrackerClient,
  type Settings,
  type TrackerChangeStream,
} from "@lorenz/domain";
import { defaultTrackerRegistry, type TrackerRegistry } from "@lorenz/tracker-sdk";

interface TrackerSource {
  client: RuntimeTrackerClient;
}

/** Runtime adapter that presents multiple named tracker clients as one collision-free stream. */
export class MultiTrackerClient implements RuntimeTrackerClient {
  private readonly sources = new Map<string, TrackerSource>();

  constructor(
    settings: Settings,
    env: NodeJS.ProcessEnv = process.env,
    registry: TrackerRegistry = defaultTrackerRegistry,
  ) {
    for (const [name, tracker] of Object.entries(settings.trackers)) {
      const sourceSettings = { ...settings, tracker };
      const provider = registry.require(tracker.kind);
      this.sources.set(name, {
        client: provider.createClient(sourceSettings, { env }),
      });
    }
    if (this.sources.size === 0) {
      throw new Error("tracker.sources must select at least one tracker");
    }
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const batches = await Promise.all(
      [...this.sources].map(async ([source, entry]) =>
        (await entry.client.fetchCandidateIssues()).map((issue) => scopeIssue(source, issue)),
      ),
    );
    return batches.flat();
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const grouped = new Map<string, string[]>();
    for (const id of ids) {
      const reference = this.reference(id);
      const sourceIds = grouped.get(reference.source) ?? [];
      sourceIds.push(reference.issueId);
      grouped.set(reference.source, sourceIds);
    }

    const found = new Map<string, Issue>();
    await Promise.all(
      [...grouped].map(async ([source, sourceIds]) => {
        const entry = this.requireSource(source);
        const issues = await entry.client.fetchIssuesByIds(sourceIds);
        for (const issue of issues) {
          const scoped = scopeIssue(source, issue);
          found.set(scoped.id, scoped);
        }
      }),
    );
    return ids.flatMap((id) => {
      const issue = found.get(id);
      return issue ? [issue] : [];
    });
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const batches = await Promise.all(
      [...this.sources].map(async ([source, entry]) => {
        if (!entry.client.fetchIssuesByStates) return [];
        return (await entry.client.fetchIssuesByStates(states)).map((issue) =>
          scopeIssue(source, issue),
        );
      }),
    );
    return batches.flat();
  }

  async acknowledgeIssue(issue: Issue): Promise<boolean> {
    const reference = this.reference(issue.id);
    const client = this.requireSource(reference.source).client;
    if (!client.acknowledgeIssue) return false;
    return client.acknowledgeIssue({ ...issue, id: reference.issueId });
  }

  async watch(onChange: () => void): Promise<TrackerChangeStream | null> {
    const streams: TrackerChangeStream[] = [];
    try {
      for (const { client } of this.sources.values()) {
        if (!client.watch) continue;
        const stream = await client.watch(onChange);
        if (stream) streams.push(stream);
      }
    } catch (error) {
      await Promise.allSettled(streams.map(async (stream) => stream.close()));
      throw error;
    }
    if (streams.length === 0) return null;
    return {
      close: async () => {
        const results = await Promise.allSettled(streams.map(async (stream) => stream.close()));
        const errors: unknown[] = [];
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason as unknown);
        }
        if (errors.length > 0) throw new AggregateError(errors, "multi-tracker watch close failed");
      },
    };
  }

  private reference(id: string) {
    const reference = parseScopedTrackerIssueId(id);
    if (!reference) throw new Error(`multi-tracker issue id is not scoped: ${id}`);
    this.requireSource(reference.source);
    return reference;
  }

  private requireSource(source: string): TrackerSource {
    const entry = this.sources.get(source);
    if (!entry) throw new Error(`multi-tracker source is not configured: ${source}`);
    return entry;
  }
}

function scopeIssue(source: string, issue: Issue): Issue {
  return { ...issue, id: scopedTrackerIssueId(source, issue.id) };
}
