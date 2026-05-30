defmodule SymphonyElixirWeb.PresenterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixirWeb.Presenter

  defmodule SnapshotServer do
    use GenServer

    def start_link(snapshot) do
      GenServer.start_link(__MODULE__, snapshot, name: __MODULE__)
    end

    def init(snapshot), do: {:ok, snapshot}

    def handle_call(:snapshot, _from, state), do: {:reply, state, state}
  end

  test "issue payload fallback sanitizes running workspace path when runtime path is missing" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_running("MONO 151/?bad")})

    assert {:ok, payload} = Presenter.issue_payload("MONO 151/?bad", SnapshotServer, 1_000)
    assert payload.workspace.path == "/tmp/workspaces/MONO_151__bad"
    assert payload.workspace.host == nil
    assert payload.status == "running"
  end

  test "issue payload fallback sanitizes retry workspace path when runtime path is missing" do
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: "/tmp/workspaces")

    start_supervised!({SnapshotServer, snapshot_with_retry("MONO 151/?bad")})

    assert {:ok, payload} = Presenter.issue_payload("MONO 151/?bad", SnapshotServer, 1_000)
    assert payload.workspace.path == "/tmp/workspaces/MONO_151__bad"
    assert payload.workspace.host == nil
    assert payload.status == "retrying"
  end

  defp snapshot_with_running(identifier) do
    %{
      running: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          state: "running",
          started_at: DateTime.utc_now(),
          session_id: "sess-1",
          usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0},
          last_agent_timestamp: nil
        }
      ],
      retrying: [],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end

  defp snapshot_with_retry(identifier) do
    %{
      running: [],
      retrying: [
        %{
          issue_id: "issue-1",
          identifier: identifier,
          attempt: 2,
          due_in_ms: 1_000,
          error: "retry later"
        }
      ],
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: nil
    }
  end
end
