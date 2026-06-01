defmodule SymphonyElixir.CoreTest do
  use SymphonyElixir.TestSupport
  alias Elixir.Config.Reader, as: ElixirConfigReader
  @solid_parse_fun String.to_atom("parse!")

  defp trace_solid_parse_calls(fun) when is_function(fun, 0) do
    :erlang.trace(self(), true, [:call])
    :erlang.trace_pattern({Solid, @solid_parse_fun, 1}, true, [:local])

    try do
      fun.()
      drain_solid_parse_calls(0)
    after
      :erlang.trace_pattern({Solid, @solid_parse_fun, 1}, false, [:local])
      :erlang.trace(self(), false, [:call])
      flush_trace_messages()
    end
  end

  defp drain_solid_parse_calls(count) do
    receive do
      {:trace, _pid, :call, {Solid, @solid_parse_fun, [_]}} ->
        drain_solid_parse_calls(count + 1)
    after
      0 -> count
    end
  end

  defp flush_trace_messages do
    receive do
      {:trace, _pid, _kind, _detail} -> flush_trace_messages()
    after
      0 -> :ok
    end
  end

  test "config defaults and validation checks" do
    write_workflow_file!(Workflow.workflow_file_path(),
      tracker_api_token: nil,
      tracker_project_slug: nil,
      poll_interval_ms: nil,
      tracker_active_states: nil,
      tracker_terminal_states: nil,
      codex_command: nil
    )

    config = Config.settings!()
    assert config.polling.interval_ms == 30_000
    assert config.tracker.active_states == ["Todo", "In Progress"]
    assert config.tracker.terminal_states == ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
    assert config.tracker.assignee == nil
    assert config.agent.max_turns == 20

    write_workflow_file!(Workflow.workflow_file_path(), poll_interval_ms: "invalid")

    assert_raise ArgumentError, ~r/interval_ms/, fn ->
      Config.settings!().polling.interval_ms
    end

    assert {:error, {:invalid_workflow_config, message}} = Config.validate()
    assert message =~ "polling.interval_ms"
    assert_raise ArgumentError, ~r/polling\.interval_ms/, fn -> Config.validate!() end

    write_workflow_file!(Workflow.workflow_file_path(), poll_interval_ms: 45_000)
    assert Config.settings!().polling.interval_ms == 45_000

    write_workflow_file!(Workflow.workflow_file_path(), max_turns: 0)
    assert {:error, {:invalid_workflow_config, message}} = Config.validate()
    assert message =~ "agent.max_turns"

    write_workflow_file!(Workflow.workflow_file_path(), max_turns: 5)
    assert Config.settings!().agent.max_turns == 5

    write_workflow_file!(Workflow.workflow_file_path(), tracker_active_states: "Todo,  Review,")
    assert {:error, {:invalid_workflow_config, message}} = Config.validate()
    assert message =~ "tracker.active_states"

    write_workflow_file!(Workflow.workflow_file_path(),
      tracker_api_token: "token",
      tracker_project_slug: nil
    )

    assert {:error, :missing_linear_project_slug} = Config.validate()
    assert_raise ArgumentError, ~r/Linear project slug missing/, fn -> Config.validate!() end

    write_workflow_file!(Workflow.workflow_file_path(),
      tracker_project_slug: "project",
      codex_command: ""
    )

    assert {:error, {:invalid_workflow_config, message}} = Config.validate()
    assert message =~ "codex.command"
    assert message =~ "can't be blank"

    write_workflow_file!(Workflow.workflow_file_path(), codex_command: "   ")
    assert :ok = Config.validate()
    assert Config.settings!().codex.command == "   "

    write_workflow_file!(Workflow.workflow_file_path(), codex_command: "/bin/sh app-server")
    assert :ok = Config.validate()

    write_workflow_file!(Workflow.workflow_file_path(), codex_approval_policy: "definitely-not-valid")
    assert :ok = Config.validate()

    write_workflow_file!(Workflow.workflow_file_path(), codex_thread_sandbox: "unsafe-ish")
    assert :ok = Config.validate()

    write_workflow_file!(Workflow.workflow_file_path(),
      codex_turn_sandbox_policy: %{type: "workspaceWrite", writableRoots: ["relative/path"]}
    )

    assert :ok = Config.validate()

    write_workflow_file!(Workflow.workflow_file_path(), codex_approval_policy: 123)
    assert {:error, {:invalid_workflow_config, message}} = Config.validate()
    assert message =~ "codex.approval_policy"

    write_workflow_file!(Workflow.workflow_file_path(), codex_thread_sandbox: 123)
    assert {:error, {:invalid_workflow_config, message}} = Config.validate()
    assert message =~ "codex.thread_sandbox"

    write_workflow_file!(Workflow.workflow_file_path(), tracker_kind: "123")
    assert {:error, {:unsupported_tracker_kind, "123"}} = Config.validate()
  end

  test "ensemble_size defaults to 1 and validates correctly" do
    write_workflow_file!(Workflow.workflow_file_path())
    assert Config.settings!().agent.ensemble_size == 1

    write_workflow_file!(Workflow.workflow_file_path(), ensemble_size: 3)
    assert Config.settings!().agent.ensemble_size == 3

    write_workflow_file!(Workflow.workflow_file_path(), ensemble_size: 0)

    assert_raise ArgumentError, ~r/agent\.ensemble_size/, fn ->
      Config.validate!()
    end

    write_workflow_file!(Workflow.workflow_file_path(), ensemble_size: -1)

    assert_raise ArgumentError, ~r/agent\.ensemble_size/, fn ->
      Config.validate!()
    end
  end

  test "current WORKFLOW.md file is valid and complete" do
    original_workflow_path = Workflow.workflow_file_path()
    on_exit(fn -> Workflow.set_workflow_file_path(original_workflow_path) end)
    Workflow.clear_workflow_file_path()

    assert {:ok, %{config: config, prompt: prompt}} = Workflow.load()
    assert is_map(config)

    tracker = Map.get(config, "tracker", %{})
    assert is_map(tracker)
    assert Map.get(tracker, "kind") == "linear"
    assert is_binary(Map.get(tracker, "project_slug"))
    assert is_list(Map.get(tracker, "active_states"))
    assert is_list(Map.get(tracker, "terminal_states"))

    assert Map.get(tracker, "dispatch") == %{
             "accept_unrouted" => true,
             "only_routes" => nil,
             "route_label_prefix" => "Symphony:"
           }

    hooks = Map.get(config, "hooks", %{})
    assert is_map(hooks)
    assert Map.get(hooks, "after_create") =~ "git clone --depth 1 https://github.com/ryanlyn/symphony ."
    assert Map.get(hooks, "after_create") =~ "cd elixir && mise trust"
    assert Map.get(hooks, "after_create") =~ "mise exec -- mix deps.get"
    assert Map.get(hooks, "before_remove") =~ "cd elixir && mise exec -- mix workspace.before_remove"

    assert String.trim(prompt) != ""
    assert is_binary(Config.workflow_prompt())
    assert Config.workflow_prompt() == prompt
  end

  test "committed workflow files include default tracker dispatch routes" do
    for workflow_name <- [
          "WORKFLOW.md",
          "WORKFLOW_FULL_ACCESS.md",
          "WORKFLOW_ENSEMBLE.md",
          "WORKFLOW_ALPHA_EVOLVE.md"
        ] do
      assert {:ok, %{config: config}} = Workflow.load(Path.expand(workflow_name, File.cwd!()))

      assert get_in(config, ["tracker", "dispatch"]) == %{
               "accept_unrouted" => true,
               "only_routes" => nil,
               "route_label_prefix" => "Symphony:"
             }
    end
  end

  test "linear api token resolves from LINEAR_API_KEY env var" do
    previous_linear_api_key = System.get_env("LINEAR_API_KEY")
    env_api_key = "test-linear-api-key"

    on_exit(fn -> restore_env("LINEAR_API_KEY", previous_linear_api_key) end)
    System.put_env("LINEAR_API_KEY", env_api_key)

    write_workflow_file!(Workflow.workflow_file_path(),
      tracker_api_token: nil,
      tracker_project_slug: "project",
      codex_command: "/bin/sh app-server"
    )

    assert Config.settings!().tracker.api_key == env_api_key
    assert Config.settings!().tracker.project_slug == "project"
    assert :ok = Config.validate!()
  end

  test "linear assignee resolves from LINEAR_ASSIGNEE env var" do
    previous_linear_assignee = System.get_env("LINEAR_ASSIGNEE")
    env_assignee = "dev@example.com"

    on_exit(fn -> restore_env("LINEAR_ASSIGNEE", previous_linear_assignee) end)
    System.put_env("LINEAR_ASSIGNEE", env_assignee)

    write_workflow_file!(Workflow.workflow_file_path(),
      tracker_assignee: nil,
      tracker_project_slug: "project",
      codex_command: "/bin/sh app-server"
    )

    assert Config.settings!().tracker.assignee == env_assignee
  end

  test "endpoint secrets resolve from Symphony env vars" do
    previous_secret_key_base = System.get_env("SYMPHONY_SECRET_KEY_BASE")
    previous_signing_salt = System.get_env("SYMPHONY_LIVE_VIEW_SIGNING_SALT")

    on_exit(fn ->
      restore_env("SYMPHONY_SECRET_KEY_BASE", previous_secret_key_base)
      restore_env("SYMPHONY_LIVE_VIEW_SIGNING_SALT", previous_signing_salt)
    end)

    System.put_env("SYMPHONY_SECRET_KEY_BASE", "env-secret-key-base")
    System.put_env("SYMPHONY_LIVE_VIEW_SIGNING_SALT", "env-signing-salt")

    endpoint_config = read_endpoint_config_from_app_config!()

    assert endpoint_config[:secret_key_base] == "env-secret-key-base"
    assert get_in(endpoint_config, [:live_view, :signing_salt]) == "env-signing-salt"
  end

  test "endpoint secrets fall back to defaults when Symphony env vars are blank" do
    previous_secret_key_base = System.get_env("SYMPHONY_SECRET_KEY_BASE")
    previous_signing_salt = System.get_env("SYMPHONY_LIVE_VIEW_SIGNING_SALT")

    on_exit(fn ->
      restore_env("SYMPHONY_SECRET_KEY_BASE", previous_secret_key_base)
      restore_env("SYMPHONY_LIVE_VIEW_SIGNING_SALT", previous_signing_salt)
    end)

    System.put_env("SYMPHONY_SECRET_KEY_BASE", "")
    System.put_env("SYMPHONY_LIVE_VIEW_SIGNING_SALT", "")

    endpoint_config = read_endpoint_config_from_app_config!()

    assert endpoint_config[:secret_key_base] == String.duplicate("s", 64)
    assert get_in(endpoint_config, [:live_view, :signing_salt]) == "symphony-live-view"
  end

  test "workflow file path defaults to WORKFLOW.md in the current working directory when app env is unset" do
    original_workflow_path = Workflow.workflow_file_path()

    on_exit(fn ->
      Workflow.set_workflow_file_path(original_workflow_path)
    end)

    Workflow.clear_workflow_file_path()

    assert Workflow.workflow_file_path() == Path.join(File.cwd!(), "WORKFLOW.md")
  end

  test "workflow file path resolves from app env when set" do
    app_workflow_path = "/tmp/app/WORKFLOW.md"

    on_exit(fn ->
      Workflow.clear_workflow_file_path()
    end)

    Workflow.set_workflow_file_path(app_workflow_path)

    assert Workflow.workflow_file_path() == app_workflow_path
  end

  test "workflow prompt helpers use the default template for blank prompts" do
    assert Workflow.effective_prompt_template("") == Workflow.default_prompt_template()
    assert Workflow.effective_prompt_template(%{prompt_template: "   "}) == Workflow.default_prompt_template()
    assert Workflow.effective_prompt_template(%{prompt_template: "Prompt body"}) == "Prompt body"
  end

  test "workflow load accepts prompt-only files without front matter" do
    workflow_path = Path.join(Path.dirname(Workflow.workflow_file_path()), "PROMPT_ONLY_WORKFLOW.md")
    File.write!(workflow_path, "Prompt only\n")

    assert {:ok, %{config: %{}, prompt: "Prompt only", prompt_template: "Prompt only"} = workflow} =
             Workflow.load(workflow_path)

    assert match?({:ok, _template}, workflow.parsed_prompt_template)
  end

  test "workflow load preserves content when front matter is unterminated" do
    workflow_path = Path.join(Path.dirname(Workflow.workflow_file_path()), "UNTERMINATED_WORKFLOW.md")
    File.write!(workflow_path, "---\ntracker:\n  kind: linear\nnote: this line should stay in the prompt\n")

    assert {:ok,
            %{
              config: %{},
              prompt: "---\ntracker:\n  kind: linear\nnote: this line should stay in the prompt",
              prompt_template: "---\ntracker:\n  kind: linear\nnote: this line should stay in the prompt"
            }} =
             Workflow.load(workflow_path)
  end

  test "workflow load accepts valid front matter with a prompt body" do
    workflow_path = Path.join(Path.dirname(Workflow.workflow_file_path()), "VALID_FRONT_MATTER_WORKFLOW.md")
    File.write!(workflow_path, "---\ntracker:\n  kind: linear\n---\nPrompt body\n")

    assert {:ok,
            %{
              config: %{"tracker" => %{"kind" => "linear"}},
              prompt: "Prompt body",
              prompt_template: "Prompt body"
            }} = Workflow.load(workflow_path)
  end

  test "workflow load rejects non-map front matter" do
    workflow_path = Path.join(Path.dirname(Workflow.workflow_file_path()), "INVALID_FRONT_MATTER_WORKFLOW.md")
    File.write!(workflow_path, "---\n- not-a-map\n---\nPrompt body\n")

    assert {:error, :workflow_front_matter_not_a_map} = Workflow.load(workflow_path)
  end

  test "SymphonyElixir.start_link delegates to the orchestrator" do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_kind: "memory")
    Application.put_env(:symphony_elixir, :memory_tracker_issues, [])
    orchestrator_pid = Process.whereis(SymphonyElixir.Orchestrator)

    on_exit(fn ->
      if is_pid(orchestrator_pid) and is_nil(Process.whereis(SymphonyElixir.Orchestrator)) do
        case Supervisor.restart_child(SymphonyElixir.Supervisor, SymphonyElixir.Orchestrator) do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
          :ignore -> :ok
          {:error, :not_found} -> :ok
        end
      end
    end)

    if is_pid(orchestrator_pid) do
      assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, SymphonyElixir.Orchestrator)
    end

    assert {:ok, pid} = SymphonyElixir.start_link()
    assert Process.whereis(SymphonyElixir.Orchestrator) == pid

    GenServer.stop(pid)
  end

  test "application restarts downstream children when orchestrator crashes" do
    previous_server_port_override = Application.get_env(:symphony_elixir, :server_port_override)
    previous_start_orchestrator = Application.get_env(:symphony_elixir, :start_orchestrator)

    Application.put_env(:symphony_elixir, :server_port_override, 0)
    Application.put_env(:symphony_elixir, :start_orchestrator, true)

    on_exit(fn ->
      stop_default_http_server()
      Application.put_env(:symphony_elixir, :start_orchestrator, previous_start_orchestrator)

      if Process.whereis(SymphonyElixir.Orchestrator) do
        assert :ok =
                 Supervisor.terminate_child(
                   SymphonyElixir.Supervisor,
                   SymphonyElixir.Orchestrator
                 )
      end

      restore_app_env(:server_port_override, previous_server_port_override)
    end)

    case Supervisor.restart_child(SymphonyElixir.Supervisor, SymphonyElixir.Orchestrator) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end

    assert {:ok, _pid} = Supervisor.restart_child(SymphonyElixir.Supervisor, SymphonyElixir.HttpServer)

    before_children = supervisor_child_pids()
    orchestrator_pid = Map.fetch!(before_children, SymphonyElixir.Orchestrator)
    http_server_pid = Map.fetch!(before_children, SymphonyElixir.HttpServer)
    dashboard_pid = Map.fetch!(before_children, SymphonyElixir.StatusDashboard)
    orchestrator_ref = Process.monitor(orchestrator_pid)

    Process.exit(orchestrator_pid, :kill)

    assert_receive {:DOWN, ^orchestrator_ref, :process, ^orchestrator_pid, :killed}, 1_000

    assert eventually(fn ->
             after_children = supervisor_child_pids()
             new_orchestrator_pid = Map.get(after_children, SymphonyElixir.Orchestrator)
             new_http_server_pid = Map.get(after_children, SymphonyElixir.HttpServer)
             new_dashboard_pid = Map.get(after_children, SymphonyElixir.StatusDashboard)

             is_pid(new_orchestrator_pid) and is_pid(new_http_server_pid) and is_pid(new_dashboard_pid) and
               new_orchestrator_pid != orchestrator_pid and new_http_server_pid != http_server_pid and
               new_dashboard_pid != dashboard_pid
           end)
  end

  test "linear issue state reconciliation fetch with no running issues is a no-op" do
    assert {:ok, []} = Client.fetch_issue_states_by_ids([])
  end

  test "running entry constructor normalizes defaults, keyword attrs, and usage totals" do
    issue = %Issue{id: "issue-running-entry", identifier: "MT-ENTRY", title: "Entry", state: "In Progress"}

    default_entry = Orchestrator.RunningEntry.new()
    assert %Orchestrator.RunningEntry{} = default_entry
    assert default_entry.usage_totals == %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0}

    entry =
      Orchestrator.RunningEntry.new(
        pid: self(),
        ref: make_ref(),
        identifier: issue.identifier,
        issue: issue,
        usage_totals: %{input_tokens: -1, output_tokens: 2, total_tokens: 3, seconds_running: -4}
      )

    assert %Orchestrator.RunningEntry{
             pid: pid,
             identifier: "MT-ENTRY",
             issue: ^issue,
             usage_totals: %{input_tokens: 0, output_tokens: 2, total_tokens: 3, seconds_running: 0}
           } = entry

    assert pid == self()

    assert Orchestrator.RunningEntry.new(%{usage_totals: :bad}).usage_totals == %{
             input_tokens: 0,
             output_tokens: 0,
             total_tokens: 0,
             seconds_running: 0
           }
  end

  test "running entry ref matching ignores malformed entries" do
    ref = make_ref()

    assert Orchestrator.RunningEntry.ref_matches?(%{ref: ref}, ref)
    refute Orchestrator.RunningEntry.ref_matches?(%{pid: self(), ref: make_ref()}, ref)
    refute Orchestrator.RunningEntry.ref_matches?(%{pid: self()}, ref)
    refute Orchestrator.RunningEntry.ref_matches?(:not_a_map, ref)
    refute Orchestrator.RunningEntry.ref_matches?(%{ref: ref}, "not-a-ref")
  end

  test "non-active issue state stops running agent without cleaning workspace" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-nonactive-reconcile-#{System.unique_integer([:positive])}"
      )

    issue_id = "issue-1"
    issue_identifier = "MT-555"
    workspace = Path.join(test_root, issue_identifier)

    try do
      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: test_root,
        tracker_active_states: ["Todo", "In Progress", "In Review"],
        tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate"]
      )

      File.mkdir_p!(test_root)
      File.mkdir_p!(workspace)

      agent_pid =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      state = %Orchestrator.State{
        running: %{
          {issue_id, 0} =>
            build_running_entry(%{
              pid: agent_pid,
              ref: nil,
              identifier: issue_identifier,
              issue: %Issue{id: issue_id, state: "Todo", identifier: issue_identifier}
            })
        },
        claimed: MapSet.new([{issue_id, 0}]),
        usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
        retry_attempts: %{}
      }

      issue = %Issue{
        id: issue_id,
        identifier: issue_identifier,
        state: "Backlog",
        title: "Queued",
        description: "Not started",
        labels: []
      }

      updated_state = Orchestrator.reconcile_issue_states_for_test([issue], state)

      refute Map.has_key?(updated_state.running, {issue_id, 0})
      refute MapSet.member?(updated_state.claimed, {issue_id, 0})
      refute Process.alive?(agent_pid)
      assert File.exists?(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "terminal issue state stops running agent and cleans workspace" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-terminal-reconcile-#{System.unique_integer([:positive])}"
      )

    issue_id = "issue-2"
    issue_identifier = "MT-556"
    workspace = Path.join(test_root, issue_identifier)

    try do
      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: test_root,
        tracker_active_states: ["Todo", "In Progress", "In Review"],
        tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate"]
      )

      File.mkdir_p!(test_root)
      File.mkdir_p!(workspace)

      agent_pid =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      state = %Orchestrator.State{
        running: %{
          {issue_id, 0} =>
            build_running_entry(%{
              pid: agent_pid,
              ref: nil,
              identifier: issue_identifier,
              issue: %Issue{id: issue_id, state: "In Progress", identifier: issue_identifier}
            })
        },
        claimed: MapSet.new([{issue_id, 0}]),
        usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
        retry_attempts: %{}
      }

      issue = %Issue{
        id: issue_id,
        identifier: issue_identifier,
        state: "Closed",
        title: "Done",
        description: "Completed",
        labels: []
      }

      updated_state = Orchestrator.reconcile_issue_states_for_test([issue], state)

      refute Map.has_key?(updated_state.running, {issue_id, 0})
      refute MapSet.member?(updated_state.claimed, {issue_id, 0})
      refute Process.alive?(agent_pid)
      refute File.exists?(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "missing running issues stop active agents without cleaning the workspace" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-missing-running-reconcile-#{System.unique_integer([:positive])}"
      )

    previous_memory_issues = Application.get_env(:symphony_elixir, :memory_tracker_issues)
    issue_id = "issue-missing"
    issue_identifier = "MT-557"

    try do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "memory",
        workspace_root: test_root,
        tracker_active_states: ["Todo", "In Progress", "In Review"],
        tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate"],
        poll_interval_ms: 30_000
      )

      Application.put_env(:symphony_elixir, :memory_tracker_issues, [])

      orchestrator_name = Module.concat(__MODULE__, :MissingRunningIssueOrchestrator)
      {:ok, pid} = Orchestrator.start_link(name: orchestrator_name)

      on_exit(fn ->
        restore_app_env(:memory_tracker_issues, previous_memory_issues)

        if Process.alive?(pid) do
          Process.exit(pid, :normal)
        end
      end)

      Process.sleep(50)

      assert {:ok, workspace} =
               SymphonyElixir.PathSafety.canonicalize(Path.join(test_root, issue_identifier))

      File.mkdir_p!(workspace)

      agent_pid =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      initial_state = :sys.get_state(pid)

      running_entry =
        build_running_entry(%{
          pid: agent_pid,
          ref: nil,
          identifier: issue_identifier,
          issue: %Issue{id: issue_id, state: "In Progress", identifier: issue_identifier}
        })

      tick_token = make_ref()

      :sys.replace_state(pid, fn _ ->
        initial_state
        |> Map.put(:running, %{{issue_id, 0} => running_entry})
        |> Map.put(:claimed, MapSet.new([{issue_id, 0}]))
        |> Map.put(:retry_attempts, %{})
        |> Map.put(:tick_timer_ref, nil)
        |> Map.put(:tick_token, tick_token)
      end)

      send(pid, {:tick, tick_token})
      Process.sleep(100)
      state = :sys.get_state(pid)

      refute Map.has_key?(state.running, {issue_id, 0})
      refute MapSet.member?(state.claimed, {issue_id, 0})
      refute Process.alive?(agent_pid)
      assert File.exists?(workspace)
    after
      restore_app_env(:memory_tracker_issues, previous_memory_issues)
      File.rm_rf(test_root)
    end
  end

  test "startup terminal workspace cleanup removes local and configured remote workspaces" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-startup-terminal-cleanup-#{System.unique_integer([:positive])}"
      )

    previous_memory_issues = Application.get_env(:symphony_elixir, :memory_tracker_issues)
    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")
    orchestrator_name = Module.concat(__MODULE__, :StartupTerminalCleanupOrchestrator)
    issue_id = "issue-startup-cleanup"
    issue_identifier = "MONO-117"

    try do
      trace_file = Path.join(test_root, "ssh.trace")
      fake_ssh = Path.join(test_root, "ssh")
      workspace_root = Path.join(test_root, "workspaces")
      local_workspace = Path.join(workspace_root, issue_identifier)

      File.mkdir_p!(local_workspace)
      File.write!(Path.join(local_workspace, "marker.txt"), "stale")
      System.put_env("SYMP_TEST_SSH_TRACE", trace_file)
      System.put_env("PATH", test_root <> ":" <> (previous_path || ""))

      File.write!(fake_ssh, """
      #!/bin/sh
      trace_file="${SYMP_TEST_SSH_TRACE:-/tmp/symphony-fake-ssh.trace}"
      printf 'ARGV:%s\\n' "$*" >> "$trace_file"
      exit 0
      """)

      File.chmod!(fake_ssh, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "memory",
        workspace_root: workspace_root,
        worker_ssh_hosts: ["worker-01:2200"],
        tracker_terminal_states: ["Done"],
        poll_interval_ms: 30_000
      )

      Application.put_env(:symphony_elixir, :memory_tracker_issues, [
        %Issue{id: issue_id, identifier: issue_identifier, state: "Done"}
      ])

      {:ok, _pid} = Orchestrator.start_link(name: orchestrator_name)

      refute File.exists?(local_workspace)

      trace = File.read!(trace_file)
      assert trace =~ "-p 2200 worker-01 bash -lc"
      assert trace =~ "rm -rf"
      assert trace =~ Path.join(workspace_root, issue_identifier)
    after
      restore_app_env(:memory_tracker_issues, previous_memory_issues)
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)

      if pid = Process.whereis(orchestrator_name) do
        Process.exit(pid, :normal)
      end

      File.rm_rf(test_root)
    end
  end

  test "reconcile updates running issue state for active issues" do
    issue_id = "issue-3"

    state = %Orchestrator.State{
      running: %{
        {issue_id, 0} =>
          build_running_entry(%{
            pid: self(),
            ref: nil,
            identifier: "MT-557",
            issue: %Issue{
              id: issue_id,
              identifier: "MT-557",
              state: "Todo"
            }
          })
      },
      claimed: MapSet.new([{issue_id, 0}]),
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      retry_attempts: %{}
    }

    issue = %Issue{
      id: issue_id,
      identifier: "MT-557",
      state: "In Progress",
      title: "Active state refresh",
      description: "State should be refreshed",
      labels: []
    }

    updated_state = Orchestrator.reconcile_issue_states_for_test([issue], state)
    updated_entry = updated_state.running[{issue_id, 0}]

    assert Map.has_key?(updated_state.running, {issue_id, 0})
    assert MapSet.member?(updated_state.claimed, {issue_id, 0})
    assert updated_entry.issue.state == "In Progress"
  end

  test "reconcile stops running issue when it is reassigned away from this worker" do
    issue_id = "issue-reassigned"

    agent_pid =
      spawn(fn ->
        receive do
          :stop -> :ok
        end
      end)

    state = %Orchestrator.State{
      running: %{
        {issue_id, 0} =>
          build_running_entry(%{
            pid: agent_pid,
            ref: nil,
            identifier: "MT-561",
            issue: %Issue{
              id: issue_id,
              identifier: "MT-561",
              state: "In Progress",
              assigned_to_worker: true
            }
          })
      },
      claimed: MapSet.new([{issue_id, 0}]),
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      retry_attempts: %{}
    }

    issue = %Issue{
      id: issue_id,
      identifier: "MT-561",
      state: "In Progress",
      title: "Reassigned active issue",
      description: "Worker should stop",
      labels: [],
      assigned_to_worker: false
    }

    updated_state = Orchestrator.reconcile_issue_states_for_test([issue], state)

    refute Map.has_key?(updated_state.running, {issue_id, 0})
    refute MapSet.member?(updated_state.claimed, {issue_id, 0})
    refute Process.alive?(agent_pid)
  end

  test "normal worker exit schedules active-state continuation retry" do
    issue_id = "issue-resume"
    ref = make_ref()
    orchestrator_name = Module.concat(__MODULE__, :ContinuationOrchestrator)
    {:ok, pid} = Orchestrator.start_link(name: orchestrator_name)

    on_exit(fn ->
      if Process.alive?(pid) do
        Process.exit(pid, :normal)
      end
    end)

    initial_state = :sys.get_state(pid)

    running_entry =
      build_running_entry(%{
        pid: self(),
        ref: ref,
        identifier: "MT-558",
        issue: %Issue{id: issue_id, identifier: "MT-558", state: "In Progress"}
      })

    :sys.replace_state(pid, fn _ ->
      initial_state
      |> Map.put(:running, %{{issue_id, 0} => running_entry})
      |> Map.put(:claimed, MapSet.new([{issue_id, 0}]))
      |> Map.put(:retry_attempts, %{})
    end)

    before_send_ms = System.monotonic_time(:millisecond)
    send(pid, {:DOWN, ref, :process, self(), :normal})
    Process.sleep(50)
    state = :sys.get_state(pid)

    refute Map.has_key?(state.running, {issue_id, 0})
    assert MapSet.member?(state.completed, issue_id)
    assert %{attempt: 1, due_at_ms: due_at_ms, timer_ref: timer_ref} = state.retry_attempts[issue_id]
    assert is_reference(timer_ref)
    assert_retry_deadline_in_range(due_at_ms, before_send_ms, 1_000, 1_500)
  end

  test "down message ignores malformed running entries without a ref" do
    issue_id = "issue-missing-ref"
    ref = make_ref()

    state = %Orchestrator.State{
      running: %{{issue_id, 0} => %{pid: self()}},
      claimed: MapSet.new([{issue_id, 0}]),
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      retry_attempts: %{}
    }

    assert {:noreply, ^state} = Orchestrator.handle_info({:DOWN, ref, :process, self(), :normal}, state)
  end

  test "abnormal worker exit increments retry attempt progressively" do
    issue_id = "issue-crash"
    ref = make_ref()
    orchestrator_name = Module.concat(__MODULE__, :CrashRetryOrchestrator)
    {:ok, pid} = Orchestrator.start_link(name: orchestrator_name)

    on_exit(fn ->
      if Process.alive?(pid) do
        Process.exit(pid, :normal)
      end
    end)

    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-crash-retry-resume-delete-#{System.unique_integer([:positive])}"
      )

    try do
      initial_state = :sys.get_state(pid)
      %{workspace: workspace} = create_git_workspace!(test_root, "MT-559")
      resume_path = Path.join(workspace, ".git/symphony/resume.json")

      assert :ok =
               SymphonyElixir.AgentResumeState.write(workspace, %{
                 agent_kind: "codex",
                 thread_id: "thread-crash",
                 issue_id: issue_id,
                 issue_identifier: "MT-559",
                 issue_state: "In Progress",
                 workspace_path: workspace
               })

      running_entry =
        build_running_entry(%{
          pid: self(),
          ref: ref,
          identifier: "MT-559",
          retry_attempt: 2,
          issue: %Issue{id: issue_id, identifier: "MT-559", state: "In Progress"},
          workspace_path: workspace
        })

      :sys.replace_state(pid, fn _ ->
        initial_state
        |> Map.put(:running, %{{issue_id, 0} => running_entry})
        |> Map.put(:claimed, MapSet.new([{issue_id, 0}]))
        |> Map.put(:retry_attempts, %{})
      end)

      before_send_ms = System.monotonic_time(:millisecond)
      send(pid, {:DOWN, ref, :process, self(), :boom})
      Process.sleep(50)
      state = :sys.get_state(pid)

      assert %{attempt: 3, due_at_ms: due_at_ms, timer_ref: timer_ref, identifier: "MT-559", error: "agent exited: :boom"} =
               state.retry_attempts[issue_id]

      assert is_reference(timer_ref)
      assert_retry_deadline_in_range(due_at_ms, before_send_ms, 40_000, 41_000)
      refute File.exists?(resume_path)
    after
      File.rm_rf(test_root)
    end
  end

  test "first abnormal worker exit waits before retrying" do
    issue_id = "issue-crash-initial"
    ref = make_ref()
    orchestrator_name = Module.concat(__MODULE__, :InitialCrashRetryOrchestrator)
    {:ok, pid} = Orchestrator.start_link(name: orchestrator_name)

    on_exit(fn ->
      if Process.alive?(pid) do
        Process.exit(pid, :normal)
      end
    end)

    initial_state = :sys.get_state(pid)

    running_entry =
      build_running_entry(%{
        pid: self(),
        ref: ref,
        identifier: "MT-560",
        issue: %Issue{id: issue_id, identifier: "MT-560", state: "In Progress"}
      })

    :sys.replace_state(pid, fn _ ->
      initial_state
      |> Map.put(:running, %{{issue_id, 0} => running_entry})
      |> Map.put(:claimed, MapSet.new([{issue_id, 0}]))
      |> Map.put(:retry_attempts, %{})
    end)

    before_send_ms = System.monotonic_time(:millisecond)
    send(pid, {:DOWN, ref, :process, self(), :boom})
    Process.sleep(50)
    state = :sys.get_state(pid)

    assert %{attempt: 1, due_at_ms: due_at_ms, timer_ref: timer_ref, identifier: "MT-560", error: "agent exited: :boom"} =
             state.retry_attempts[issue_id]

    assert is_reference(timer_ref)
    assert_retry_deadline_in_range(due_at_ms, before_send_ms, 10_000, 10_500)
  end

  test "stale retry timer messages do not consume newer retry entries" do
    issue_id = "issue-stale-retry"
    orchestrator_name = Module.concat(__MODULE__, :StaleRetryOrchestrator)
    {:ok, pid} = Orchestrator.start_link(name: orchestrator_name)

    on_exit(fn ->
      if Process.alive?(pid) do
        Process.exit(pid, :normal)
      end
    end)

    initial_state = :sys.get_state(pid)
    current_retry_token = make_ref()
    stale_retry_token = make_ref()

    :sys.replace_state(pid, fn _ ->
      initial_state
      |> Map.put(:retry_attempts, %{
        issue_id => %{
          attempt: 2,
          timer_ref: nil,
          retry_token: current_retry_token,
          due_at_ms: System.monotonic_time(:millisecond) + 30_000,
          identifier: "MT-561",
          error: "agent exited: :boom"
        }
      })
    end)

    send(pid, {:retry_issue, issue_id, stale_retry_token})
    Process.sleep(50)

    assert %{
             attempt: 2,
             retry_token: ^current_retry_token,
             identifier: "MT-561",
             error: "agent exited: :boom"
           } = :sys.get_state(pid).retry_attempts[issue_id]
  end

  test "retry dispatch reopens an active issue slot with only a stale claim" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-stale-claim-retry-#{System.unique_integer([:positive])}"
      )

    previous_memory_issues = Application.get_env(:symphony_elixir, :memory_tracker_issues)
    issue_id = "issue-stale-claim-retry"
    retry_token = make_ref()

    try do
      File.mkdir_p!(test_root)
      fake_codex = Path.join(test_root, "fake-codex")

      File.write!(fake_codex, """
      #!/bin/sh
      sleep 30
      """)

      File.chmod!(fake_codex, 0o755)

      issue = %Issue{
        id: issue_id,
        identifier: "CAN-77",
        title: "Retry stale claim",
        description: "The retry should reclaim the orphaned slot.",
        state: "Todo",
        labels: []
      }

      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "memory",
        workspace_root: Path.join(test_root, "workspaces"),
        max_concurrent_agents: 10,
        ensemble_size: 1,
        codex_command: "#{fake_codex} app-server",
        codex_read_timeout_ms: 10_000
      )

      Application.put_env(:symphony_elixir, :memory_tracker_issues, [issue])

      state = %Orchestrator.State{
        poll_interval_ms: 30_000,
        max_concurrent_agents: 10,
        max_retry_backoff_ms: 300_000,
        active_states: MapSet.new(["todo", "in progress"]),
        terminal_states: MapSet.new(["closed", "cancelled", "canceled", "duplicate", "done"]),
        dispatch_settings: Config.settings!().tracker.dispatch,
        claimed: MapSet.new([{issue_id, 0}]),
        retry_attempts: %{
          issue_id => %{
            attempt: 1,
            timer_ref: nil,
            retry_token: retry_token,
            due_at_ms: System.monotonic_time(:millisecond),
            identifier: issue.identifier,
            error: "agent exited: {:agent_runner_timeout, \"workspace.create_for_issue\", 300000}"
          }
        },
        usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0}
      }

      assert {:noreply, updated_state} = Orchestrator.handle_info({:retry_issue, issue_id, retry_token}, state)

      on_exit(fn ->
        updated_state.running
        |> Map.values()
        |> Enum.each(fn
          %{pid: pid} when is_pid(pid) -> Task.Supervisor.terminate_child(SymphonyElixir.TaskSupervisor, pid)
          _entry -> :ok
        end)
      end)

      assert %{identifier: "CAN-77", retry_attempt: 1} = updated_state.running[{issue_id, 0}]
      assert MapSet.member?(updated_state.claimed, {issue_id, 0})
      refute Map.has_key?(updated_state.retry_attempts, issue_id)
    after
      restore_app_env(:memory_tracker_issues, previous_memory_issues)
      File.rm_rf(test_root)
    end
  end

  test "manual refresh coalesces repeated requests and ignores superseded ticks" do
    now_ms = System.monotonic_time(:millisecond)
    stale_tick_token = make_ref()

    state = %Orchestrator.State{
      poll_interval_ms: 30_000,
      max_concurrent_agents: 1,
      next_poll_due_at_ms: now_ms + 30_000,
      poll_check_in_progress: false,
      tick_timer_ref: nil,
      tick_token: stale_tick_token,
      usage_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      codex_rate_limits: nil
    }

    assert {:reply, %{queued: true, coalesced: false}, refreshed_state} =
             Orchestrator.handle_call(:request_refresh, {self(), make_ref()}, state)

    assert is_reference(refreshed_state.tick_timer_ref)
    assert is_reference(refreshed_state.tick_token)
    refute refreshed_state.tick_token == stale_tick_token
    assert refreshed_state.next_poll_due_at_ms <= System.monotonic_time(:millisecond)

    assert {:reply, %{queued: true, coalesced: true}, coalesced_state} =
             Orchestrator.handle_call(:request_refresh, {self(), make_ref()}, refreshed_state)

    assert coalesced_state.tick_token == refreshed_state.tick_token
    assert {:noreply, ^coalesced_state} = Orchestrator.handle_info({:tick, stale_tick_token}, coalesced_state)
  end

  test "select_worker_host_for_test skips full ssh hosts under the shared per-host cap" do
    write_workflow_file!(Workflow.workflow_file_path(),
      worker_ssh_hosts: ["worker-a", "worker-b"],
      worker_max_concurrent_agents_per_host: 1
    )

    state = %Orchestrator.State{
      running: %{
        "issue-1" => %{worker_host: "worker-a"}
      }
    }

    assert Orchestrator.select_worker_host_for_test(state, nil) == "worker-b"
  end

  test "select_worker_host_for_test returns no_worker_capacity when every ssh host is full" do
    write_workflow_file!(Workflow.workflow_file_path(),
      worker_ssh_hosts: ["worker-a", "worker-b"],
      worker_max_concurrent_agents_per_host: 1
    )

    state = %Orchestrator.State{
      running: %{
        "issue-1" => %{worker_host: "worker-a"},
        "issue-2" => %{worker_host: "worker-b"}
      }
    }

    assert Orchestrator.select_worker_host_for_test(state, nil) == :no_worker_capacity
  end

  test "select_worker_host_for_test keeps the preferred ssh host when it still has capacity" do
    write_workflow_file!(Workflow.workflow_file_path(),
      worker_ssh_hosts: ["worker-a", "worker-b"],
      worker_max_concurrent_agents_per_host: 2
    )

    state = %Orchestrator.State{
      running: %{
        "issue-1" => %{worker_host: "worker-a"},
        "issue-2" => %{worker_host: "worker-b"}
      }
    }

    assert Orchestrator.select_worker_host_for_test(state, "worker-a") == "worker-a"
  end

  defp assert_retry_deadline_in_range(due_at_ms, started_at_ms, min_delay_ms, max_delay_ms) do
    scheduled_delay_ms = due_at_ms - started_at_ms

    assert is_integer(due_at_ms)
    assert scheduled_delay_ms >= min_delay_ms
    assert scheduled_delay_ms <= max_delay_ms
  end

  defp supervisor_child_pids do
    Supervisor.which_children(SymphonyElixir.Supervisor)
    |> Enum.reduce(%{}, fn {id, pid, _type, _modules}, acc ->
      Map.put(acc, id, pid)
    end)
  end

  defp eventually(fun, attempts \\ 20)
  defp eventually(fun, attempts) when attempts <= 0, do: fun.()

  defp eventually(fun, attempts) when is_function(fun, 0) do
    if fun.() do
      true
    else
      Process.sleep(50)
      eventually(fun, attempts - 1)
    end
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_app_env(key, value), do: Application.put_env(:symphony_elixir, key, value)

  test "fetch issues by states with empty state set is a no-op" do
    assert {:ok, []} = Client.fetch_issues_by_states([])
  end

  test "prompt builder renders issue and attempt values from workflow template" do
    workflow_prompt =
      "Ticket {{ issue.identifier }} {{ issue.title }} labels={{ issue.labels }} attempt={{ attempt }}"

    write_workflow_file!(Workflow.workflow_file_path(), prompt: workflow_prompt)

    issue = %Issue{
      identifier: "S-1",
      title: "Refactor backend request path",
      description: "Replace transport layer",
      state: "Todo",
      url: "https://example.org/issues/S-1",
      labels: ["backend"]
    }

    prompt = PromptBuilder.build_prompt(issue, attempt: 3)

    assert prompt =~ "Ticket S-1 Refactor backend request path"
    assert prompt =~ "labels=backend"
    assert prompt =~ "attempt=3"
  end

  test "prompt builder reuses cached parsed templates across repeated calls" do
    workflow_prompt = "Ticket {{ issue.identifier }} attempt={{ attempt }}"
    write_workflow_file!(Workflow.workflow_file_path(), prompt: workflow_prompt)

    issue = %Issue{
      identifier: "MONO-142",
      title: "Cache parsed prompt template",
      description: "Avoid reparsing",
      state: "In Progress",
      url: "https://example.org/issues/MONO-142",
      labels: ["improvement"]
    }

    parse_calls =
      trace_solid_parse_calls(fn ->
        assert PromptBuilder.build_prompt(issue, attempt: 1) == "Ticket MONO-142 attempt=1"
        assert PromptBuilder.build_prompt(issue, attempt: 2) == "Ticket MONO-142 attempt=2"
      end)

    assert parse_calls == 0
  end

  test "prompt builder renders issue datetime fields without crashing" do
    workflow_prompt = "Ticket {{ issue.identifier }} created={{ issue.created_at }} updated={{ issue.updated_at }}"

    write_workflow_file!(Workflow.workflow_file_path(), prompt: workflow_prompt)

    created_at = DateTime.from_naive!(~N[2026-02-26 18:06:48], "Etc/UTC")
    updated_at = DateTime.from_naive!(~N[2026-02-26 18:07:03], "Etc/UTC")

    issue = %Issue{
      identifier: "MT-697",
      title: "Live smoke",
      description: "Prompt should serialize datetimes",
      state: "Todo",
      url: "https://example.org/issues/MT-697",
      labels: [],
      created_at: created_at,
      updated_at: updated_at
    }

    prompt = PromptBuilder.build_prompt(issue)

    assert prompt =~ "Ticket MT-697"
    assert prompt =~ "created=2026-02-26T18:06:48Z"
    assert prompt =~ "updated=2026-02-26T18:07:03Z"
  end

  test "prompt builder normalizes nested date-like values, maps, and structs in issue fields" do
    write_workflow_file!(Workflow.workflow_file_path(), prompt: "Ticket {{ issue.identifier }}")

    issue = %Issue{
      identifier: "MT-701",
      title: "Serialize nested values",
      description: "Prompt builder should normalize nested terms",
      state: "Todo",
      url: "https://example.org/issues/MT-701",
      labels: [
        ~N[2026-02-27 12:34:56],
        ~D[2026-02-28],
        ~T[12:34:56],
        %{phase: "test"},
        URI.parse("https://example.org/issues/MT-701")
      ]
    }

    assert PromptBuilder.build_prompt(issue) == "Ticket MT-701"
  end

  test "prompt builder uses strict variable rendering" do
    workflow_prompt = "Work on ticket {{ missing.ticket_id }} and follow these steps."

    write_workflow_file!(Workflow.workflow_file_path(), prompt: workflow_prompt)

    issue = %Issue{
      identifier: "MT-123",
      title: "Investigate broken sync",
      description: "Reproduce and fix",
      state: "In Progress",
      url: "https://example.org/issues/MT-123",
      labels: ["bug"]
    }

    assert_raise Solid.RenderError, fn ->
      PromptBuilder.build_prompt(issue)
    end
  end

  test "prompt builder surfaces invalid template content with prompt context" do
    write_workflow_file!(Workflow.workflow_file_path(), prompt: "{% if issue.identifier %}")

    issue = %Issue{
      identifier: "MT-999",
      title: "Broken prompt",
      description: "Invalid template syntax",
      state: "Todo",
      url: "https://example.org/issues/MT-999",
      labels: []
    }

    assert_raise RuntimeError, ~r/template_parse_error:.*template="/s, fn ->
      PromptBuilder.build_prompt(issue)
    end
  end

  test "prompt builder uses a sensible default template when workflow prompt is blank" do
    write_workflow_file!(Workflow.workflow_file_path(), prompt: "   \n")

    issue = %Issue{
      identifier: "MT-777",
      title: "Make fallback prompt useful",
      description: "Include enough issue context to start working.",
      state: "In Progress",
      url: "https://example.org/issues/MT-777",
      labels: ["prompt"]
    }

    prompt = PromptBuilder.build_prompt(issue)

    assert prompt =~ "You are working on a Linear issue."
    assert prompt =~ "Identifier: MT-777"
    assert prompt =~ "Title: Make fallback prompt useful"
    assert prompt =~ "Body:"
    assert prompt =~ "Include enough issue context to start working."
    assert Config.workflow_prompt() =~ "{{ issue.identifier }}"
    assert Config.workflow_prompt() =~ "{{ issue.title }}"
    assert Config.workflow_prompt() =~ "{{ issue.description }}"
  end

  test "prompt builder default template handles missing issue body" do
    write_workflow_file!(Workflow.workflow_file_path(), prompt: "")

    issue = %Issue{
      identifier: "MT-778",
      title: "Handle empty body",
      description: nil,
      state: "Todo",
      url: "https://example.org/issues/MT-778",
      labels: []
    }

    prompt = PromptBuilder.build_prompt(issue)

    assert prompt =~ "Identifier: MT-778"
    assert prompt =~ "Title: Handle empty body"
    assert prompt =~ "No description provided."
  end

  test "config workflow_prompt falls back to the default template when workflow is unavailable" do
    original_workflow_path = Workflow.workflow_file_path()
    workflow_store_pid = Process.whereis(SymphonyElixir.WorkflowStore)

    on_exit(fn ->
      Workflow.set_workflow_file_path(original_workflow_path)

      if is_pid(workflow_store_pid) and is_nil(Process.whereis(SymphonyElixir.WorkflowStore)) do
        Supervisor.restart_child(SymphonyElixir.Supervisor, SymphonyElixir.WorkflowStore)
      end
    end)

    assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, SymphonyElixir.WorkflowStore)

    Workflow.set_workflow_file_path(Path.join(System.tmp_dir!(), "missing-workflow-#{System.unique_integer([:positive])}.md"))

    assert Config.workflow_prompt() == Workflow.default_prompt_template()
  end

  test "prompt builder reports workflow load failures separately from template parse errors" do
    original_workflow_path = Workflow.workflow_file_path()
    workflow_store_pid = Process.whereis(SymphonyElixir.WorkflowStore)

    on_exit(fn ->
      Workflow.set_workflow_file_path(original_workflow_path)

      if is_pid(workflow_store_pid) and is_nil(Process.whereis(SymphonyElixir.WorkflowStore)) do
        Supervisor.restart_child(SymphonyElixir.Supervisor, SymphonyElixir.WorkflowStore)
      end
    end)

    assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, SymphonyElixir.WorkflowStore)

    Workflow.set_workflow_file_path(Path.join(System.tmp_dir!(), "missing-workflow-#{System.unique_integer([:positive])}.md"))

    issue = %Issue{
      identifier: "MT-780",
      title: "Workflow unavailable",
      description: "Missing workflow file",
      state: "Todo",
      url: "https://example.org/issues/MT-780",
      labels: []
    }

    assert_raise RuntimeError, ~r/workflow_unavailable:/, fn ->
      PromptBuilder.build_prompt(issue)
    end
  end

  test "in-repo WORKFLOW.md renders correctly" do
    workflow_path = Workflow.workflow_file_path()
    Workflow.set_workflow_file_path(Path.expand("WORKFLOW.md", File.cwd!()))

    issue = %Issue{
      identifier: "MT-616",
      title: "Use rich templates for WORKFLOW.md",
      description: "Render with rich template variables",
      state: "In Progress",
      url: "https://example.org/issues/MT-616/use-rich-templates-for-workflowmd",
      labels: ["templating", "workflow"]
    }

    on_exit(fn -> Workflow.set_workflow_file_path(workflow_path) end)

    prompt = PromptBuilder.build_prompt(issue, attempt: 2)

    assert prompt =~ "You are working on a Linear ticket `MT-616`"
    assert prompt =~ "Issue context:"
    assert prompt =~ "Identifier: MT-616"
    assert prompt =~ "Title: Use rich templates for WORKFLOW.md"
    assert prompt =~ "Current status: In Progress"
    assert prompt =~ "https://example.org/issues/MT-616/use-rich-templates-for-workflowmd"
    assert prompt =~ "This is an unattended orchestration session."
    assert prompt =~ "Only stop early for a true blocker"
    assert prompt =~ "Do not include \"next steps for user\""
    assert prompt =~ "open and follow `.codex/skills/symphony-land/SKILL.md`"
    assert prompt =~ "Do not call `gh pr merge` directly"
    assert prompt =~ "Continuation context:"
    assert prompt =~ "retry attempt #2"
  end

  test "in-repo WORKFLOW_ENSEMBLE.md renders correctly" do
    workflow_path = Workflow.workflow_file_path()
    Workflow.set_workflow_file_path(Path.expand("WORKFLOW_ENSEMBLE.md", File.cwd!()))

    issue = %Issue{
      identifier: "MT-777",
      title: "Coordinate safely without runtime locks",
      description: "Render ensemble guidance from the selected workflow template",
      state: "In Progress",
      url: "https://example.org/issues/MT-777/coordinate-safely-without-runtime-locks",
      labels: ["ensemble", "workflow"]
    }

    on_exit(fn -> Workflow.set_workflow_file_path(workflow_path) end)

    prompt = PromptBuilder.build_prompt(issue, attempt: 2, slot_index: 1, ensemble_size: 3)

    assert prompt =~ "You are working on a Linear ticket `MT-777`"
    assert prompt =~ "You are independent agent with 0-indexed id: `1` (out of `3` total agents)"
    assert prompt =~ "Come up with independent work on the ticket yourself"
    assert prompt =~ "your own tracking workpad comment"
    assert prompt =~ "Status: COMPLETE"
    assert prompt =~ "all expected ensemble workpads are marked `Status: COMPLETE`"
    assert prompt =~ "retry attempt #2"
  end

  test "in-repo WORKFLOW_ALPHA_EVOLVE.md renders correctly" do
    workflow_path = Workflow.workflow_file_path()
    Workflow.set_workflow_file_path(Path.expand("WORKFLOW_ALPHA_EVOLVE.md", File.cwd!()))

    issue = %Issue{
      identifier: "MT-888",
      title: "Evolve stronger candidate selection for workflow docs",
      description: "Render AlphaEvolve-style guidance from the selected workflow template",
      state: "In Progress",
      url: "https://example.org/issues/MT-888/evolve-stronger-candidate-selection-for-workflow-docs",
      labels: ["workflow", "ensemble:3"]
    }

    on_exit(fn -> Workflow.set_workflow_file_path(workflow_path) end)

    prompt = PromptBuilder.build_prompt(issue, attempt: 2, slot_index: 2, ensemble_size: 3)

    assert prompt =~ "You are working on a Linear ticket `MT-888`"
    assert prompt =~ "Independent population-member context:"
    assert prompt =~ "Treat the ticket as a search problem, not a single-shot implementation task."
    assert prompt =~ "### Candidate Ledger"
    assert prompt =~ "Status: COMPLETE"
    assert prompt =~ "move the ticket to `Agent Review`"
    assert prompt =~ "retry attempt #2"
  end

  test "prompt builder adds continuation guidance for retries" do
    workflow_prompt = "{% if attempt %}Retry #" <> "{{ attempt }}" <> "{% endif %}"
    write_workflow_file!(Workflow.workflow_file_path(), prompt: workflow_prompt)

    issue = %Issue{
      identifier: "MT-201",
      title: "Continue autonomous ticket",
      description: "Retry flow",
      state: "In Progress",
      url: "https://example.org/issues/MT-201",
      labels: []
    }

    prompt = PromptBuilder.build_prompt(issue, attempt: 2)

    assert prompt == "Retry #2"
  end

  test "build_prompt exposes nested ensemble variables when ensemble_size > 1" do
    write_workflow_file!(
      Workflow.workflow_file_path(),
      prompt: "{% if ensemble.enabled %}slot {{ ensemble.slot_index }} of {{ ensemble.size }}{% endif %}"
    )

    issue = %Issue{id: "id-1", identifier: "TEST-1", title: "Test", description: "Desc", state: "Todo"}

    prompt = PromptBuilder.build_prompt(issue, slot_index: 1, ensemble_size: 3)
    assert prompt =~ "slot 1 of 3"
  end

  test "build_prompt exposes nested ensemble variables for solo runs" do
    write_workflow_file!(
      Workflow.workflow_file_path(),
      prompt: "{% if ensemble.enabled %}multi{% else %}solo {{ ensemble.slot_index }} of {{ ensemble.size }}{% endif %}"
    )

    issue = %Issue{id: "id-1", identifier: "TEST-1", title: "Test", description: "Desc", state: "Todo"}

    prompt = PromptBuilder.build_prompt(issue, slot_index: 0, ensemble_size: 1)
    assert prompt == "solo 0 of 1"
  end

  test "build_prompt defaults ensemble variables when ensemble_size not specified" do
    write_workflow_file!(
      Workflow.workflow_file_path(),
      prompt: "{% if ensemble.enabled %}multi{% else %}solo {{ ensemble.slot_index }} of {{ ensemble.size }}{% endif %}"
    )

    issue = %Issue{id: "id-1", identifier: "TEST-1", title: "Test", description: "Desc", state: "Todo"}

    prompt = PromptBuilder.build_prompt(issue)
    assert prompt == "solo 0 of 1"
  end

  test "agent runner keeps workspace after successful codex run" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-retain-workspace-#{System.unique_integer([:positive])}"
      )

    try do
      template_repo = Path.join(test_root, "source")
      workspace_root = Path.join(test_root, "workspaces")
      codex_binary = Path.join(test_root, "fake-codex")

      File.mkdir_p!(template_repo)
      File.mkdir_p!(workspace_root)
      File.write!(Path.join(template_repo, "README.md"), "# test")
      System.cmd("git", ["-C", template_repo, "init", "-b", "main"])
      System.cmd("git", ["-C", template_repo, "config", "user.name", "Test User"])
      System.cmd("git", ["-C", template_repo, "config", "user.email", "test@example.com"])
      System.cmd("git", ["-C", template_repo, "add", "README.md"])
      System.cmd("git", ["-C", template_repo, "commit", "-m", "initial"])

      File.write!(codex_binary, """
      #!/bin/sh
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        case "$count" in
          1)
            printf '%s\\n' '{\"id\":1,\"result\":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-1\"}}}'
            ;;
          4)
            printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-1\"}}}'
            printf '%s\\n' '{\"method\":\"turn/completed\"}'
            exit 0
            ;;
          *)
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "cp #{Path.join(template_repo, "README.md")} README.md",
        codex_command: "#{codex_binary} app-server"
      )

      issue = %Issue{
        identifier: "S-99",
        title: "Smoke test",
        description: "Run and keep workspace",
        state: "In Progress",
        url: "https://example.org/issues/S-99",
        labels: ["backend"]
      }

      before = MapSet.new(File.ls!(workspace_root))
      assert :ok = AgentRunner.run(issue)
      entries_after = MapSet.new(File.ls!(workspace_root))

      created =
        MapSet.difference(entries_after, before) |> Enum.filter(&(&1 == "S-99"))

      created = MapSet.new(created)

      assert MapSet.size(created) == 1
      workspace_name = created |> Enum.to_list() |> List.first()
      assert workspace_name == "S-99"

      issue_dir = Path.join(workspace_root, workspace_name)
      assert File.exists?(issue_dir)
      assert File.exists?(Path.join(issue_dir, "README.md"))
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner forwards timestamped codex updates to recipient" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-updates-#{System.unique_integer([:positive])}"
      )

    try do
      template_repo = Path.join(test_root, "source")
      workspace_root = Path.join(test_root, "workspaces")
      codex_binary = Path.join(test_root, "fake-codex")

      File.mkdir_p!(template_repo)
      File.write!(Path.join(template_repo, "README.md"), "# test")
      System.cmd("git", ["-C", template_repo, "init", "-b", "main"])
      System.cmd("git", ["-C", template_repo, "config", "user.name", "Test User"])
      System.cmd("git", ["-C", template_repo, "config", "user.email", "test@example.com"])
      System.cmd("git", ["-C", template_repo, "add", "README.md"])
      System.cmd("git", ["-C", template_repo, "commit", "-m", "initial"])

      File.write!(
        codex_binary,
        """
        #!/bin/sh
        count=0
        while IFS= read -r line; do
          count=$((count + 1))
          case "$count" in
            1)
              printf '%s\\n' '{\"id\":1,\"result\":{}}'
              ;;
            2)
              printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-live\"}}}'
              ;;
            3)
              printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-live\"}}}'
              ;;
            4)
              printf '%s\\n' '{\"method\":\"turn/completed\"}'
              ;;
            *)
              ;;
          esac
        done
        """
      )

      File.chmod!(codex_binary, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "cp #{Path.join(template_repo, "README.md")} README.md",
        codex_command: "#{codex_binary} app-server"
      )

      issue = %Issue{
        id: "issue-live-updates",
        identifier: "MT-99",
        title: "Smoke test",
        description: "Capture codex updates",
        state: "In Progress",
        url: "https://example.org/issues/MT-99",
        labels: ["backend"]
      }

      test_pid = self()

      assert :ok =
               AgentRunner.run(
                 issue,
                 test_pid,
                 issue_state_fetcher: fn [_issue_id] -> {:ok, [%{issue | state: "Done"}]} end
               )

      assert_receive {:agent_worker_update, "issue-live-updates",
                      %{
                        agent_kind: "codex",
                        event: :session_started,
                        timestamp: %DateTime{},
                        session_id: session_id
                      }},
                     500

      assert session_id == "thread-live-turn-live"
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner surfaces ssh startup failures instead of silently hopping hosts" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-single-host-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    try do
      trace_file = Path.join(test_root, "ssh.trace")
      fake_ssh = Path.join(test_root, "ssh")

      File.mkdir_p!(test_root)
      System.put_env("SYMP_TEST_SSH_TRACE", trace_file)
      System.put_env("PATH", test_root <> ":" <> (previous_path || ""))

      File.write!(fake_ssh, """
      #!/bin/sh
      trace_file="${SYMP_TEST_SSH_TRACE:-/tmp/symphony-fake-ssh.trace}"
      printf 'ARGV:%s\\n' "$*" >> "$trace_file"

      case "$*" in
        *worker-a*"__SYMPHONY_WORKSPACE__"*)
          printf '%s\\n' 'worker-a prepare failed' >&2
          exit 75
          ;;
        *worker-b*"__SYMPHONY_WORKSPACE__"*)
          printf '%s\\t%s\\t%s\\n' '__SYMPHONY_WORKSPACE__' '1' '/remote/home/.symphony-remote-workspaces/MT-SSH-FAILOVER'
          exit 0
          ;;
        *)
          exit 0
          ;;
      esac
      """)

      File.chmod!(fake_ssh, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: "~/.symphony-remote-workspaces",
        worker_ssh_hosts: ["worker-a", "worker-b"]
      )

      issue = %Issue{
        id: "issue-ssh-failover",
        identifier: "MT-SSH-FAILOVER",
        title: "Do not fail over within a single worker run",
        description: "Surface the startup failure to the orchestrator",
        state: "In Progress"
      }

      assert_raise RuntimeError, ~r/remote_home_lookup_failed|workspace_prepare_failed/, fn ->
        AgentRunner.run(issue, nil, worker_host: "worker-a")
      end

      trace = File.read!(trace_file)
      assert trace =~ "worker-a bash -lc"
      refute trace =~ "worker-b bash -lc"
    after
      File.rm_rf(test_root)
    end
  end

  test "agent runner continues with a follow-up turn while the issue remains active" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-continuation-#{System.unique_integer([:positive])}"
      )

    try do
      template_repo = Path.join(test_root, "source")
      workspace_root = Path.join(test_root, "workspaces")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex.trace")

      File.mkdir_p!(template_repo)
      File.write!(Path.join(template_repo, "README.md"), "# test")
      System.cmd("git", ["-C", template_repo, "init", "-b", "main"])
      System.cmd("git", ["-C", template_repo, "config", "user.name", "Test User"])
      System.cmd("git", ["-C", template_repo, "config", "user.email", "test@example.com"])
      System.cmd("git", ["-C", template_repo, "add", "README.md"])
      System.cmd("git", ["-C", template_repo, "commit", "-m", "initial"])

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex.trace}"
      run_id="$(date +%s%N)-$$"
      printf 'RUN:%s\\n' "$run_id" >> "$trace_file"
      count=0

      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"
        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-cont"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-cont-1"}}}'
            printf '%s\\n' '{"method":"turn/completed"}'
            ;;
          5)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-cont-2"}}}'
            printf '%s\\n' '{"method":"turn/completed"}'
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)
      System.put_env("SYMP_TEST_CODEx_TRACE", trace_file)

      on_exit(fn -> System.delete_env("SYMP_TEST_CODEx_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "cp #{Path.join(template_repo, "README.md")} README.md",
        codex_command: "#{codex_binary} app-server",
        max_turns: 3
      )

      parent = self()

      state_fetcher = fn [_issue_id] ->
        attempt = Process.get(:agent_turn_fetch_count, 0) + 1
        Process.put(:agent_turn_fetch_count, attempt)
        send(parent, {:issue_state_fetch, attempt})

        state =
          if attempt == 1 do
            "In Progress "
          else
            "Done"
          end

        {:ok,
         [
           %Issue{
             id: "issue-continue",
             identifier: "MT-247",
             title: "Continue until done",
             description: "Still active after first turn",
             state: state
           }
         ]}
      end

      issue = %Issue{
        id: "issue-continue",
        identifier: "MT-247",
        title: "Continue until done",
        description: "Still active after first turn",
        state: "In Progress ",
        url: "https://example.org/issues/MT-247",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: state_fetcher)
      assert_receive {:issue_state_fetch, 1}
      assert_receive {:issue_state_fetch, 2}

      lines = File.read!(trace_file) |> String.split("\n", trim: true)

      assert length(Enum.filter(lines, &String.starts_with?(&1, "RUN:"))) == 1
      assert length(Enum.filter(lines, &String.contains?(&1, "\"method\":\"thread/start\""))) == 1

      turn_texts =
        lines
        |> Enum.filter(&String.starts_with?(&1, "JSON:"))
        |> Enum.map(&String.trim_leading(&1, "JSON:"))
        |> Enum.map(&Jason.decode!/1)
        |> Enum.filter(&(&1["method"] == "turn/start"))
        |> Enum.map(fn payload ->
          get_in(payload, ["params", "input"])
          |> Enum.map_join("\n", &Map.get(&1, "text", ""))
        end)

      assert length(turn_texts) == 2
      assert Enum.at(turn_texts, 0) =~ "You are an agent for this repository."
      refute Enum.at(turn_texts, 1) =~ "You are an agent for this repository."
      assert Enum.at(turn_texts, 1) =~ "Continuation guidance:"
      assert Enum.at(turn_texts, 1) =~ "continuation turn #2 of 3"
    after
      System.delete_env("SYMP_TEST_CODEx_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner stops continuing once agent.max_turns is reached" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-max-turns-#{System.unique_integer([:positive])}"
      )

    try do
      template_repo = Path.join(test_root, "source")
      workspace_root = Path.join(test_root, "workspaces")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex.trace")

      File.mkdir_p!(template_repo)
      File.write!(Path.join(template_repo, "README.md"), "# test")
      System.cmd("git", ["-C", template_repo, "init", "-b", "main"])
      System.cmd("git", ["-C", template_repo, "config", "user.name", "Test User"])
      System.cmd("git", ["-C", template_repo, "config", "user.email", "test@example.com"])
      System.cmd("git", ["-C", template_repo, "add", "README.md"])
      System.cmd("git", ["-C", template_repo, "commit", "-m", "initial"])

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex.trace}"
      printf 'RUN\\n' >> "$trace_file"
      count=0

      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"
        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-max"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-max-1"}}}'
            printf '%s\\n' '{"method":"turn/completed"}'
            ;;
          5)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-max-2"}}}'
            printf '%s\\n' '{"method":"turn/completed"}'
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)
      System.put_env("SYMP_TEST_CODEx_TRACE", trace_file)

      on_exit(fn -> System.delete_env("SYMP_TEST_CODEx_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "cp #{Path.join(template_repo, "README.md")} README.md",
        codex_command: "#{codex_binary} app-server",
        max_turns: 2
      )

      state_fetcher = fn [_issue_id] ->
        {:ok,
         [
           %Issue{
             id: "issue-max-turns",
             identifier: "MT-248",
             title: "Stop at max turns",
             description: "Still active",
             state: "In Progress"
           }
         ]}
      end

      issue = %Issue{
        id: "issue-max-turns",
        identifier: "MT-248",
        title: "Stop at max turns",
        description: "Still active",
        state: "In Progress",
        url: "https://example.org/issues/MT-248",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: state_fetcher)

      trace = File.read!(trace_file)
      assert length(String.split(trace, "RUN", trim: true)) == 1
      assert length(Regex.scan(~r/"method":"turn\/start"/, trace)) == 2
    after
      System.delete_env("SYMP_TEST_CODEx_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner resumes from persisted workspace resume state" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-resume-state-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: workspace, canonical_workspace: canonical_workspace} =
        create_git_workspace!(test_root, "MT-301")

      resume_path = Path.join(workspace, ".git/symphony/resume.json")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-resume.trace")

      write_resume_state_fixture!(
        resume_path,
        %{
          "thread_id" => "thread-saved",
          "issue_id" => "issue-resume-state",
          "issue_identifier" => "MT-301",
          "issue_state" => "In Progress",
          "workspace_path" => canonical_workspace
        }
      )

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-resume.trace}"
      printf 'RUN\\n' >> "$trace_file"

      while IFS= read -r line; do
        printf 'JSON:%s\\n' "$line" >> "$trace_file"
        case "$line" in
          *'"id":1'*)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          *'"method":"thread/resume"'*)
            printf '%s\\n' '{"id":4,"result":{"thread":{"id":"thread-saved"}}}'
            ;;
          *'"method":"turn/start"'*)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-saved"}}}'
            printf '%s\\n' '{"method":"turn/completed"}'
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)
      System.put_env("SYMP_TEST_CODEx_TRACE", trace_file)

      on_exit(fn -> System.delete_env("SYMP_TEST_CODEx_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue = %Issue{
        id: "issue-resume-state",
        identifier: "MT-301",
        title: "Resume persisted thread",
        description: "Use the stored thread id for the next run",
        state: "In Progress",
        url: "https://example.org/issues/MT-301",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)

      trace = File.read!(trace_file)
      assert length(Regex.scan(~r/"method":"thread\/resume"/, trace)) == 1
      refute String.contains?(trace, "\"method\":\"thread/start\"")

      persisted = Jason.decode!(File.read!(resume_path))
      assert persisted["thread_id"] == "thread-saved"
      assert persisted["issue_state"] == "In Progress"
      assert persisted["session_id"] == "thread-saved-turn-saved"
    after
      System.delete_env("SYMP_TEST_CODEx_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner surfaces resume failures for orchestrator-owned retries" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-resume-fallback-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: workspace, canonical_workspace: canonical_workspace} =
        create_git_workspace!(test_root, "MT-302")

      resume_path = Path.join(workspace, ".git/symphony/resume.json")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-resume-fallback.trace")

      write_resume_state_fixture!(
        resume_path,
        %{
          "thread_id" => "thread-stale",
          "issue_id" => "issue-resume-fallback",
          "issue_identifier" => "MT-302",
          "issue_state" => "In Progress",
          "workspace_path" => canonical_workspace
        }
      )

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-resume-fallback.trace}"
      printf 'RUN\\n' >> "$trace_file"

      while IFS= read -r line; do
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$line" in
          *'"id":1'*)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          *'"method":"thread/resume"'*)
            printf '%s\\n' '{"id":4,"error":{"code":-32000,"message":"no rollout found"}}'
            exit 0
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)
      System.put_env("SYMP_TEST_CODEx_TRACE", trace_file)

      on_exit(fn -> System.delete_env("SYMP_TEST_CODEx_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue = %Issue{
        id: "issue-resume-fallback",
        identifier: "MT-302",
        title: "Surface resume failure",
        description: "Let the orchestrator own retries after a resume failure",
        state: "In Progress",
        url: "https://example.org/issues/MT-302",
        labels: []
      }

      assert_raise RuntimeError, ~r/Agent run failed/, fn ->
        AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      end

      trace = File.read!(trace_file)
      assert length(Regex.scan(~r/^RUN$/m, trace)) == 1
      assert length(Regex.scan(~r/"method":"thread\/resume"/, trace)) == 1
      refute String.contains?(trace, "\"method\":\"thread/start\"")

      persisted = Jason.decode!(File.read!(resume_path))
      assert persisted["thread_id"] == "thread-stale"
      assert persisted["issue_state"] == "In Progress"
      assert is_nil(persisted["session_id"])
    after
      System.delete_env("SYMP_TEST_CODEx_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner starts fresh when the persisted issue state changed" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-status-fresh-start-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: workspace, canonical_workspace: canonical_workspace} =
        create_git_workspace!(test_root, "MT-303")

      resume_path = Path.join(workspace, ".git/symphony/resume.json")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-status-fresh.trace")

      write_resume_state_fixture!(
        resume_path,
        %{
          "thread_id" => "thread-human-review",
          "issue_id" => "issue-status-fresh",
          "issue_identifier" => "MT-303",
          "issue_state" => "Human Review",
          "workspace_path" => canonical_workspace
        }
      )

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-status-fresh.trace}"
      printf 'RUN\\n' >> "$trace_file"

      while IFS= read -r line; do
        printf 'JSON:%s\\n' "$line" >> "$trace_file"
        case "$line" in
          *'"id":1'*)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          *'"method":"thread/start"'*)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-new-status"}}}'
            ;;
          *'"method":"turn/start"'*)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-new-status"}}}'
            printf '%s\\n' '{"method":"turn/completed"}'
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)
      System.put_env("SYMP_TEST_CODEx_TRACE", trace_file)

      on_exit(fn -> System.delete_env("SYMP_TEST_CODEx_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue = %Issue{
        id: "issue-status-fresh",
        identifier: "MT-303",
        title: "Fresh session on status change",
        description: "A status transition should force a new Codex thread",
        state: "In Progress",
        url: "https://example.org/issues/MT-303",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)

      trace = File.read!(trace_file)
      refute String.contains?(trace, "\"method\":\"thread/resume\"")
      assert length(Regex.scan(~r/"method":"thread\/start"/, trace)) == 1

      persisted = Jason.decode!(File.read!(resume_path))
      assert persisted["thread_id"] == "thread-new-status"
      assert persisted["issue_state"] == "In Progress"
    after
      System.delete_env("SYMP_TEST_CODEx_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner continues with a follow-up Claude turn while the issue remains active" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-agent-runner-continuation-#{System.unique_integer([:positive])}"
      )

    try do
      template_repo = Path.join(test_root, "source")
      workspace_root = Path.join(test_root, "workspaces")
      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude.trace")

      initialize_template_repo!(template_repo)

      File.write!(
        claude_binary,
        fake_streaming_claude_script(
          """
          session_id='claude-session-1'
          """,
          """
          printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$session_id\\"}"
          printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"done\\",\\"session_id\\":\\"$session_id\\",\\"usage\\":{\\"input_tokens\\":6,\\"output_tokens\\":2}}"
          """
        )
      )

      File.chmod!(claude_binary, 0o755)
      System.put_env("SYMP_TEST_CLAUDE_TRACE", trace_file)
      on_exit(fn -> System.delete_env("SYMP_TEST_CLAUDE_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_after_create: "cp #{Path.join(template_repo, "README.md")} README.md",
        agent_kind: "claude",
        claude_command: claude_binary,
        max_turns: 3
      )

      parent = self()

      state_fetcher = fn [_issue_id] ->
        attempt = Process.get(:claude_agent_turn_fetch_count, 0) + 1
        Process.put(:claude_agent_turn_fetch_count, attempt)
        send(parent, {:issue_state_fetch, attempt})

        state = if attempt == 1, do: "In Progress", else: "Done"

        {:ok,
         [
           %Issue{
             id: "issue-claude-continue",
             identifier: "MT-CLAUDE-247",
             title: "Continue until done",
             description: "Still active after first claude turn",
             state: state
           }
         ]}
      end

      issue = %Issue{
        id: "issue-claude-continue",
        identifier: "MT-CLAUDE-247",
        title: "Continue until done",
        description: "Still active after first claude turn",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-247",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: state_fetcher)
      assert_receive {:issue_state_fetch, 1}
      assert_receive {:issue_state_fetch, 2}

      trace = File.read!(trace_file)
      assert length(Regex.scan(~r/^ARGV:/m, trace)) == 1
      refute trace =~ "--resume claude-session-1"

      prompt_1 = (trace_file <> ".stdin.1") |> File.read!() |> Jason.decode!() |> get_in(["message", "content"])
      prompt_2 = (trace_file <> ".stdin.2") |> File.read!() |> Jason.decode!() |> get_in(["message", "content"])

      assert prompt_1 =~ "You are an agent for this repository."
      refute prompt_2 =~ "You are an agent for this repository."
      assert prompt_2 =~ "Continuation guidance:"
      assert prompt_2 =~ "continuation turn #2 of 3"
    after
      System.delete_env("SYMP_TEST_CLAUDE_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner resolves executor kind and Claude runtime settings from issue status" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-agent-runner-status-override-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: _workspace} =
        create_git_workspace!(test_root, "MT-CLAUDE-STATUS-OVERRIDE")

      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude-status-override.trace")

      File.write!(
        claude_binary,
        fake_streaming_claude_script(
          """
          session_id='claude-status-override'
          """,
          """
          printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$session_id\\"}"
          printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"done\\",\\"session_id\\":\\"$session_id\\",\\"usage\\":{\\"input_tokens\\":5,\\"output_tokens\\":2}}"
          """
        )
      )

      File.chmod!(claude_binary, 0o755)
      System.put_env("SYMP_TEST_CLAUDE_TRACE", trace_file)
      on_exit(fn -> System.delete_env("SYMP_TEST_CLAUDE_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "codex",
        codex_command: "/definitely/missing-codex app-server",
        claude_command: "/definitely/missing-claude",
        status_overrides: %{
          "Todo" => %{
            "agent" => %{"kind" => "claude"},
            "claude" => %{
              "command" => claude_binary,
              "model" => "claude-sonnet-4",
              "permission_mode" => "acceptEdits"
            }
          }
        }
      )

      issue = %Issue{
        id: "issue-claude-status-override",
        identifier: "MT-CLAUDE-STATUS-OVERRIDE",
        title: "Resolved Claude status override",
        description: "Use the status override to select Claude with override runtime settings",
        state: "Todo",
        url: "https://example.org/issues/MT-CLAUDE-STATUS-OVERRIDE",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)

      trace = File.read!(trace_file)
      assert trace =~ "--model claude-sonnet-4"
      assert trace =~ "--permission-mode acceptEdits"
    after
      System.delete_env("SYMP_TEST_CLAUDE_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner resumes from persisted Claude resume state" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-agent-runner-resume-state-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: workspace, canonical_workspace: canonical_workspace} =
        create_git_workspace!(test_root, "MT-CLAUDE-301")

      resume_path = Path.join(workspace, ".git/symphony/resume.json")
      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude-resume.trace")

      write_resume_state_fixture!(resume_path, %{
        "agent_kind" => "claude",
        "resume_id" => "claude-saved",
        "issue_id" => "issue-claude-resume-state",
        "issue_identifier" => "MT-CLAUDE-301",
        "issue_state" => "In Progress",
        "workspace_path" => canonical_workspace
      })

      File.write!(
        claude_binary,
        fake_streaming_claude_script(
          """
          if ! printf '%s' "$*" | grep -q -- '--resume claude-saved'; then
            exit 3
          fi

          session_id='claude-saved'
          """,
          """
          printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$session_id\\"}"
          printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"done\\",\\"session_id\\":\\"$session_id\\",\\"usage\\":{\\"input_tokens\\":4,\\"output_tokens\\":1}}"
          """
        )
      )

      File.chmod!(claude_binary, 0o755)
      System.put_env("SYMP_TEST_CLAUDE_TRACE", trace_file)
      on_exit(fn -> System.delete_env("SYMP_TEST_CLAUDE_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: claude_binary
      )

      issue = %Issue{
        id: "issue-claude-resume-state",
        identifier: "MT-CLAUDE-301",
        title: "Resume persisted claude session",
        description: "Use the stored claude session id for the next run",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-301",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)

      trace = File.read!(trace_file)
      assert trace =~ "--resume claude-saved"

      persisted = Jason.decode!(File.read!(resume_path))
      assert persisted["agent_kind"] == "claude"
      assert persisted["resume_id"] == "claude-saved"
      assert persisted["session_id"] == "claude-saved"
    after
      System.delete_env("SYMP_TEST_CLAUDE_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner surfaces Claude resume failures for orchestrator-owned retries" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-agent-runner-resume-fallback-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: workspace, canonical_workspace: canonical_workspace} =
        create_git_workspace!(test_root, "MT-CLAUDE-302")

      resume_path = Path.join(workspace, ".git/symphony/resume.json")
      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude-resume-fallback.trace")

      write_resume_state_fixture!(resume_path, %{
        "agent_kind" => "claude",
        "resume_id" => "claude-stale",
        "issue_id" => "issue-claude-resume-fallback",
        "issue_identifier" => "MT-CLAUDE-302",
        "issue_state" => "In Progress",
        "workspace_path" => canonical_workspace
      })

      File.write!(
        claude_binary,
        fake_streaming_claude_script(
          """
          if printf '%s' "$*" | grep -q -- '--resume claude-stale'; then
            exit 1
          fi

          session_id='claude-new'
          """,
          """
          printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$session_id\\"}"
          printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"done\\",\\"session_id\\":\\"$session_id\\",\\"usage\\":{\\"input_tokens\\":4,\\"output_tokens\\":1}}"
          """
        )
      )

      File.chmod!(claude_binary, 0o755)
      System.put_env("SYMP_TEST_CLAUDE_TRACE", trace_file)
      on_exit(fn -> System.delete_env("SYMP_TEST_CLAUDE_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: claude_binary
      )

      issue = %Issue{
        id: "issue-claude-resume-fallback",
        identifier: "MT-CLAUDE-302",
        title: "Surface claude resume failure",
        description: "Let the orchestrator own retries after a claude resume failure",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-302",
        labels: []
      }

      assert_raise RuntimeError, ~r/Agent run failed/, fn ->
        AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)
      end

      trace = File.read!(trace_file)
      assert length(Regex.scan(~r/^ARGV:/m, trace)) == 1
      assert trace =~ "--resume claude-stale"

      persisted = Jason.decode!(File.read!(resume_path))
      assert persisted["agent_kind"] == "claude"
      assert persisted["resume_id"] == "claude-stale"
      assert is_nil(persisted["session_id"])
    after
      System.delete_env("SYMP_TEST_CLAUDE_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner starts fresh for Claude when the persisted issue state changed" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-agent-runner-status-fresh-start-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: workspace, canonical_workspace: canonical_workspace} =
        create_git_workspace!(test_root, "MT-CLAUDE-303")

      resume_path = Path.join(workspace, ".git/symphony/resume.json")
      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude-status-fresh.trace")

      write_resume_state_fixture!(resume_path, %{
        "agent_kind" => "claude",
        "resume_id" => "claude-human-review",
        "issue_id" => "issue-claude-status-fresh",
        "issue_identifier" => "MT-CLAUDE-303",
        "issue_state" => "Human Review",
        "workspace_path" => canonical_workspace
      })

      File.write!(
        claude_binary,
        fake_streaming_claude_script(
          """
          if printf '%s' "$*" | grep -q -- '--resume '; then
            exit 5
          fi

          session_id='claude-new-status'
          """,
          """
          printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$session_id\\"}"
          printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"done\\",\\"session_id\\":\\"$session_id\\",\\"usage\\":{\\"input_tokens\\":4,\\"output_tokens\\":1}}"
          """
        )
      )

      File.chmod!(claude_binary, 0o755)
      System.put_env("SYMP_TEST_CLAUDE_TRACE", trace_file)
      on_exit(fn -> System.delete_env("SYMP_TEST_CLAUDE_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: claude_binary
      )

      issue = %Issue{
        id: "issue-claude-status-fresh",
        identifier: "MT-CLAUDE-303",
        title: "Fresh claude session on status change",
        description: "A status transition should force a new Claude resume id",
        state: "In Progress",
        url: "https://example.org/issues/MT-CLAUDE-303",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)

      trace = File.read!(trace_file)
      refute trace =~ "--resume "
      persisted = Jason.decode!(File.read!(resume_path))
      assert persisted["agent_kind"] == "claude"
      assert persisted["resume_id"] == "claude-new-status"
      assert persisted["issue_state"] == "In Progress"
    after
      System.delete_env("SYMP_TEST_CLAUDE_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "agent runner starts fresh when the resolved executor kind changed" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-agent-runner-kind-fresh-start-#{System.unique_integer([:positive])}"
      )

    try do
      %{workspace_root: workspace_root, workspace: workspace, canonical_workspace: canonical_workspace} =
        create_git_workspace!(test_root, "MT-CLAUDE-304")

      resume_path = Path.join(workspace, ".git/symphony/resume.json")
      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude-kind-fresh.trace")

      write_resume_state_fixture!(resume_path, %{
        "agent_kind" => "codex",
        "resume_id" => "codex-thread-stale",
        "thread_id" => "codex-thread-stale",
        "issue_id" => "issue-claude-kind-fresh",
        "issue_identifier" => "MT-CLAUDE-304",
        "issue_state" => "Todo",
        "workspace_path" => canonical_workspace
      })

      File.write!(
        claude_binary,
        fake_streaming_claude_script(
          """
          if printf '%s' "$*" | grep -q -- '--resume '; then
            exit 5
          fi

          session_id='claude-kind-fresh'
          """,
          """
          printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$session_id\\"}"
          printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"done\\",\\"session_id\\":\\"$session_id\\",\\"usage\\":{\\"input_tokens\\":4,\\"output_tokens\\":1}}"
          """
        )
      )

      File.chmod!(claude_binary, 0o755)
      System.put_env("SYMP_TEST_CLAUDE_TRACE", trace_file)
      on_exit(fn -> System.delete_env("SYMP_TEST_CLAUDE_TRACE") end)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "codex",
        codex_command: "/definitely/missing-codex app-server",
        claude_command: "/definitely/missing-claude",
        status_overrides: %{
          "Todo" => %{
            "agent" => %{"kind" => "claude"},
            "claude" => %{"command" => claude_binary}
          }
        }
      )

      issue = %Issue{
        id: "issue-claude-kind-fresh",
        identifier: "MT-CLAUDE-304",
        title: "Fresh Claude session on executor change",
        description: "An executor change should force a fresh Claude resume id",
        state: "Todo",
        url: "https://example.org/issues/MT-CLAUDE-304",
        labels: []
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: fn _ -> {:ok, []} end)

      trace = File.read!(trace_file)
      refute trace =~ "--resume "

      persisted = Jason.decode!(File.read!(resume_path))
      assert persisted["agent_kind"] == "claude"
      assert persisted["resume_id"] == "claude-kind-fresh"
      assert persisted["issue_state"] == "Todo"
    after
      System.delete_env("SYMP_TEST_CLAUDE_TRACE")
      File.rm_rf(test_root)
    end
  end

  test "app server starts with workspace cwd and expected startup command" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-app-server-args-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-77")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-args.trace")
      previous_trace = System.get_env("SYMP_TEST_CODex_TRACE")

      on_exit(fn ->
        if is_binary(previous_trace) do
          System.put_env("SYMP_TEST_CODex_TRACE", previous_trace)
        else
          System.delete_env("SYMP_TEST_CODex_TRACE")
        end
      end)

      System.put_env("SYMP_TEST_CODex_TRACE", trace_file)
      File.mkdir_p!(workspace)

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODex_TRACE:-/tmp/codex-args.trace}"
      count=0
      printf 'ARGV:%s\\n' \"$*\" >> \"$trace_file\"
      printf 'CWD:%s\\n' \"$PWD\" >> \"$trace_file\"

      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' \"$line\" >> \"$trace_file\"
        case \"$count\" in
          1)
            printf '%s\\n' '{\"id\":1,\"result\":{}}'
            ;;
          2)
            printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-77\"}}}'
            ;;
          3)
            printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-77\"}}}'
            ;;
          4)
            printf '%s\\n' '{\"method\":\"turn/completed\"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue = %Issue{
        id: "issue-args",
        identifier: "MT-77",
        title: "Validate codex args",
        description: "Check startup args and cwd",
        state: "In Progress",
        url: "https://example.org/issues/MT-77",
        labels: ["backend"]
      }

      assert {:ok, _result} = AppServer.run(workspace, "Fix workspace start args", issue)
      assert {:ok, canonical_workspace} = SymphonyElixir.PathSafety.canonicalize(workspace)

      trace = File.read!(trace_file)
      lines = String.split(trace, "\n", trim: true)

      assert argv_line = Enum.find(lines, fn line -> String.starts_with?(line, "ARGV:") end)
      assert String.contains?(argv_line, "app-server")
      refute Enum.any?(lines, &String.contains?(&1, "--yolo"))
      assert cwd_line = Enum.find(lines, fn line -> String.starts_with?(line, "CWD:") end)
      assert String.ends_with?(cwd_line, Path.basename(workspace))

      assert Enum.any?(lines, fn line ->
               if String.starts_with?(line, "JSON:") do
                 line
                 |> String.trim_leading("JSON:")
                 |> Jason.decode!()
                 |> then(fn payload ->
                   expected_approval_policy = %{
                     "reject" => %{
                       "sandbox_approval" => true,
                       "rules" => true,
                       "mcp_elicitations" => true
                     }
                   }

                   payload["method"] == "thread/start" &&
                     get_in(payload, ["params", "approvalPolicy"]) == expected_approval_policy &&
                     get_in(payload, ["params", "sandbox"]) == "workspace-write" &&
                     get_in(payload, ["params", "cwd"]) == canonical_workspace
                 end)
               else
                 false
               end
             end)

      expected_turn_sandbox_policy = %{
        "type" => "workspaceWrite",
        "writableRoots" => [canonical_workspace],
        "readOnlyAccess" => %{"type" => "fullAccess"},
        "networkAccess" => false,
        "excludeTmpdirEnvVar" => false,
        "excludeSlashTmp" => false
      }

      assert Enum.any?(lines, fn line ->
               if String.starts_with?(line, "JSON:") do
                 line
                 |> String.trim_leading("JSON:")
                 |> Jason.decode!()
                 |> then(fn payload ->
                   expected_approval_policy = %{
                     "reject" => %{
                       "sandbox_approval" => true,
                       "rules" => true,
                       "mcp_elicitations" => true
                     }
                   }

                   payload["method"] == "turn/start" &&
                     get_in(payload, ["params", "cwd"]) == canonical_workspace &&
                     get_in(payload, ["params", "approvalPolicy"]) == expected_approval_policy &&
                     get_in(payload, ["params", "sandboxPolicy"]) == expected_turn_sandbox_policy
                 end)
               else
                 false
               end
             end)
    after
      File.rm_rf(test_root)
    end
  end

  test "app server inherits parent environment variables" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-app-server-env-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-177")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-env.trace")
      inherited_key = "SYMPHONY_TEST_INHERITED_ENV"
      inherited_value = "value-#{System.unique_integer([:positive])}"
      previous_trace = System.get_env("SYMP_TEST_CODex_TRACE")
      previous_env = System.get_env(inherited_key)

      on_exit(fn ->
        if is_binary(previous_trace) do
          System.put_env("SYMP_TEST_CODex_TRACE", previous_trace)
        else
          System.delete_env("SYMP_TEST_CODex_TRACE")
        end

        if is_binary(previous_env) do
          System.put_env(inherited_key, previous_env)
        else
          System.delete_env(inherited_key)
        end
      end)

      System.put_env("SYMP_TEST_CODex_TRACE", trace_file)
      System.put_env(inherited_key, inherited_value)
      File.mkdir_p!(workspace)

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODex_TRACE:-/tmp/codex-env.trace}"
      count=0
      printf 'INHERITED:%s\\n' "${SYMPHONY_TEST_INHERITED_ENV}" >> "$trace_file"

      while IFS= read -r line; do
        count=$((count + 1))
        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-177"}}}'
            ;;
          3)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-177"}}}'
            ;;
          4)
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue = %Issue{
        id: "issue-env",
        identifier: "MT-177",
        title: "Validate inherited env",
        description: "Check startup environment inheritance",
        state: "In Progress",
        url: "https://example.org/issues/MT-177",
        labels: ["backend"]
      }

      assert {:ok, _result} = AppServer.run(workspace, "Validate inherited env", issue)

      trace = File.read!(trace_file)
      assert String.contains?(trace, "INHERITED:#{inherited_value}")
    after
      File.rm_rf(test_root)
    end
  end

  test "app server startup command supports codex args override from workflow config" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-app-server-custom-args-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-88")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-custom-args.trace")
      previous_trace = System.get_env("SYMP_TEST_CODex_TRACE")

      on_exit(fn ->
        if is_binary(previous_trace) do
          System.put_env("SYMP_TEST_CODex_TRACE", previous_trace)
        else
          System.delete_env("SYMP_TEST_CODex_TRACE")
        end
      end)

      System.put_env("SYMP_TEST_CODex_TRACE", trace_file)
      File.mkdir_p!(workspace)

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODex_TRACE:-/tmp/codex-custom-args.trace}"
      count=0
      printf 'ARGV:%s\\n' \"$*\" >> \"$trace_file\"

      while IFS= read -r line; do
        count=$((count + 1))
        case \"$count\" in
          1)
            printf '%s\\n' '{\"id\":1,\"result\":{}}'
            ;;
          2)
            printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-88\"}}}'
            ;;
          3)
            printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-88\"}}}'
            ;;
          4)
            printf '%s\\n' '{\"method\":\"turn/completed\"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} --model gpt-5.3-codex app-server"
      )

      issue = %Issue{
        id: "issue-custom-args",
        identifier: "MT-88",
        title: "Validate custom codex args",
        description: "Check startup args override",
        state: "In Progress",
        url: "https://example.org/issues/MT-88",
        labels: ["backend"]
      }

      assert {:ok, _result} = AppServer.run(workspace, "Fix workspace start args", issue)

      trace = File.read!(trace_file)
      lines = String.split(trace, "\n", trim: true)

      assert argv_line = Enum.find(lines, fn line -> String.starts_with?(line, "ARGV:") end)
      assert String.contains?(argv_line, "--model gpt-5.3-codex app-server")
      refute String.contains?(argv_line, "--ask-for-approval never")
      refute String.contains?(argv_line, "--sandbox danger-full-access")
    after
      File.rm_rf(test_root)
    end
  end

  test "app server startup payload uses configurable approval and sandbox settings from workflow config" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-app-server-policy-overrides-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-99")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-policy-overrides.trace")
      previous_trace = System.get_env("SYMP_TEST_CODex_TRACE")

      on_exit(fn ->
        if is_binary(previous_trace) do
          System.put_env("SYMP_TEST_CODex_TRACE", previous_trace)
        else
          System.delete_env("SYMP_TEST_CODex_TRACE")
        end
      end)

      System.put_env("SYMP_TEST_CODex_TRACE", trace_file)
      File.mkdir_p!(workspace)

      File.write!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODex_TRACE:-/tmp/codex-policy-overrides.trace}"
      count=0

      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-99"}}}'
            ;;
          3)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-99"}}}'
            ;;
          4)
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      File.chmod!(codex_binary, 0o755)

      workspace_cache = Path.join(Path.expand(workspace), ".cache")
      File.mkdir_p!(workspace_cache)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server",
        codex_approval_policy: "on-request",
        codex_thread_sandbox: "workspace-write",
        codex_turn_sandbox_policy: %{
          type: "workspaceWrite",
          writableRoots: [Path.expand(workspace), workspace_cache]
        }
      )

      issue = %Issue{
        id: "issue-policy-overrides",
        identifier: "MT-99",
        title: "Validate codex policy overrides",
        description: "Check startup policy payload overrides",
        state: "In Progress",
        url: "https://example.org/issues/MT-99",
        labels: ["backend"]
      }

      assert {:ok, _result} = AppServer.run(workspace, "Fix workspace start args", issue)

      lines = File.read!(trace_file) |> String.split("\n", trim: true)

      assert Enum.any?(lines, fn line ->
               if String.starts_with?(line, "JSON:") do
                 line
                 |> String.trim_leading("JSON:")
                 |> Jason.decode!()
                 |> then(fn payload ->
                   payload["method"] == "thread/start" &&
                     get_in(payload, ["params", "approvalPolicy"]) == "on-request" &&
                     get_in(payload, ["params", "sandbox"]) == "workspace-write"
                 end)
               else
                 false
               end
             end)

      expected_turn_policy = %{
        "type" => "workspaceWrite",
        "writableRoots" => [Path.expand(workspace), workspace_cache]
      }

      assert Enum.any?(lines, fn line ->
               if String.starts_with?(line, "JSON:") do
                 line
                 |> String.trim_leading("JSON:")
                 |> Jason.decode!()
                 |> then(fn payload ->
                   payload["method"] == "turn/start" &&
                     get_in(payload, ["params", "approvalPolicy"]) == "on-request" &&
                     get_in(payload, ["params", "sandboxPolicy"]) == expected_turn_policy
                 end)
               else
                 false
               end
             end)
    after
      File.rm_rf(test_root)
    end
  end

  defp write_resume_state_fixture!(resume_path, state) do
    File.mkdir_p!(Path.dirname(resume_path))
    File.write!(resume_path, Jason.encode!(state))
  end

  defp initialize_template_repo!(template_repo) do
    File.mkdir_p!(template_repo)
    File.write!(Path.join(template_repo, "README.md"), "# test")
    System.cmd("git", ["-C", template_repo, "init", "-b", "main"])
    System.cmd("git", ["-C", template_repo, "config", "user.name", "Test User"])
    System.cmd("git", ["-C", template_repo, "config", "user.email", "test@example.com"])
    System.cmd("git", ["-C", template_repo, "add", "README.md"])
    System.cmd("git", ["-C", template_repo, "commit", "-m", "initial"])
  end

  defp read_endpoint_config_from_app_config! do
    "config/config.exs"
    |> ElixirConfigReader.read!(env: Mix.env())
    |> Keyword.fetch!(:symphony_elixir)
    |> Keyword.fetch!(SymphonyElixirWeb.Endpoint)
  end

  defp fake_streaming_claude_script(startup_body, turn_body)
       when is_binary(startup_body) and is_binary(turn_body) do
    """
    #!/bin/sh
    trace_file="${SYMP_TEST_CLAUDE_TRACE:-/tmp/claude.trace}"

    case "$1" in
      --help)
        cat <<'EOF'
    Usage: claude [options]
      -p, --print
      --exclude-dynamic-system-prompt-sections
      --verbose
      --output-format <format>
      --input-format <format>
      --resume [value]
      --permission-mode <mode>
      --model <model>
      --mcp-config <configs...>
      --strict-mcp-config
    EOF
        exit 0
        ;;
      --version)
        printf '%s\\n' '2.1.88 (Claude Code)'
        exit 0
        ;;
    esac

    printf 'ARGV:%s\\n' "$*" >> "$trace_file"
    #{startup_body}

    count=0

    while IFS= read -r line; do
      count=$((count + 1))
      printf '%s' "$count" > "${trace_file}.count"
      printf '%s' "$line" > "${trace_file}.stdin.$count"
      #{turn_body}
    done
    """
  end
end
