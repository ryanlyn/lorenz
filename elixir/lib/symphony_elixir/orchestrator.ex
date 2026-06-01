defmodule SymphonyElixir.Orchestrator do
  @moduledoc """
  Polls Linear and dispatches repository copies to agent-backed workers.
  """

  use GenServer
  require Logger
  import Bitwise, only: [<<<: 2]

  alias SymphonyElixir.{AgentResumeState, AgentRunner, Config, StatusDashboard, Tracker, Workspace}
  alias SymphonyElixir.Config.Schema
  alias SymphonyElixir.Linear.Issue
  alias SymphonyElixir.Tracker.Dispatch, as: TrackerDispatch

  @continuation_retry_delay_ms 1_000
  @failure_retry_base_ms 10_000
  # Slightly above the dashboard render interval so "checking now…" can render.
  @poll_transition_render_delay_ms 20
  @default_max_retry_backoff_ms 300_000
  @empty_usage_totals %{
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0
  }
  @empty_cost_summary %{
    estimated_cost_usd: nil
  }

  defmodule RunningEntry do
    @moduledoc false

    @empty_usage_totals %{
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0
    }

    @type usage_totals_t :: %{
            input_tokens: non_neg_integer(),
            output_tokens: non_neg_integer(),
            total_tokens: non_neg_integer(),
            seconds_running: non_neg_integer()
          }

    @type t :: %__MODULE__{
            pid: pid() | nil,
            ref: reference() | nil,
            agent_kind: String.t() | nil,
            identifier: String.t() | nil,
            issue: SymphonyElixir.Linear.Issue.t() | nil,
            slot_index: non_neg_integer(),
            ensemble_size: pos_integer(),
            worker_host: String.t() | nil,
            workspace_path: String.t() | nil,
            run_id: String.t() | nil,
            resume_id: String.t() | nil,
            session_id: String.t() | nil,
            executor_pid: String.t() | nil,
            stall_timeout_ms: non_neg_integer() | nil,
            usage_totals: usage_totals_t,
            usage_last_reported_input_tokens: non_neg_integer(),
            usage_last_reported_output_tokens: non_neg_integer(),
            usage_last_reported_total_tokens: non_neg_integer(),
            last_agent_message: map() | nil,
            last_agent_timestamp: DateTime.t() | nil,
            last_agent_event: term(),
            turn_count: non_neg_integer(),
            retry_attempt: non_neg_integer(),
            started_at: DateTime.t() | nil
          }

    defstruct pid: nil,
              ref: nil,
              agent_kind: "codex",
              identifier: nil,
              issue: nil,
              slot_index: 0,
              ensemble_size: 1,
              worker_host: nil,
              workspace_path: nil,
              run_id: nil,
              resume_id: nil,
              session_id: nil,
              executor_pid: nil,
              stall_timeout_ms: nil,
              usage_totals: @empty_usage_totals,
              usage_last_reported_input_tokens: 0,
              usage_last_reported_output_tokens: 0,
              usage_last_reported_total_tokens: 0,
              last_agent_message: nil,
              last_agent_timestamp: nil,
              last_agent_event: nil,
              turn_count: 0,
              retry_attempt: 0,
              started_at: nil

    @spec new() :: t()
    def new, do: new(%{})

    @spec new(map() | keyword()) :: t()
    def new(attrs) when is_list(attrs) do
      attrs
      |> Enum.into(%{})
      |> new()
    end

    def new(attrs) when is_map(attrs) do
      attrs
      |> Map.update(:usage_totals, @empty_usage_totals, &normalize_usage_totals/1)
      |> then(&struct(__MODULE__, &1))
    end

    @spec ref_matches?(term(), reference()) :: boolean()
    def ref_matches?(entry, ref) when is_map(entry) and is_reference(ref) do
      Map.get(entry, :ref) == ref
    end

    def ref_matches?(_entry, _ref), do: false

    defp normalize_usage_totals(totals) when is_map(totals) do
      %{
        input_tokens: max(0, Map.get(totals, :input_tokens, 0)),
        output_tokens: max(0, Map.get(totals, :output_tokens, 0)),
        total_tokens: max(0, Map.get(totals, :total_tokens, 0)),
        seconds_running: max(0, Map.get(totals, :seconds_running, 0))
      }
    end

    defp normalize_usage_totals(_totals), do: @empty_usage_totals
  end

  defmodule State do
    @moduledoc """
    Runtime state for the orchestrator polling loop.
    """

    defstruct [
      :poll_interval_ms,
      :max_concurrent_agents,
      :max_retry_backoff_ms,
      :worker_max_concurrent_agents_per_host,
      :next_poll_due_at_ms,
      :poll_check_in_progress,
      :tick_timer_ref,
      :tick_token,
      active_states: MapSet.new(),
      terminal_states: MapSet.new(),
      dispatch_settings: nil,
      worker_ssh_hosts: [],
      running: %{},
      blocked_dispatches: [],
      completed: MapSet.new(),
      claimed: MapSet.new(),
      next_run_id: 1,
      run_history: [],
      # Keyed by issue_id (not slot_key). This is intentional: retries re-dispatch
      # all unfilled slots via do_dispatch_issue, so per-slot retry tracking is
      # unnecessary. If two slots fail in sequence, the later retry subsumes the earlier.
      retry_attempts: %{},
      usage_totals: nil,
      codex_rate_limits: nil
    ]
  end

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_if_enabled, [opts]}
    }
  end

  @spec start_if_enabled(keyword()) :: GenServer.on_start() | :ignore
  def start_if_enabled(opts \\ []) do
    if start_on_boot?() do
      start_link(opts)
    else
      :ignore
    end
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  defp start_on_boot? do
    Application.get_env(:symphony_elixir, :start_orchestrator, true)
  end

  @impl true
  def init(opts) do
    state =
      %State{
        usage_totals: @empty_usage_totals,
        codex_rate_limits: nil,
        next_run_id: 1,
        run_history: []
      }
      |> apply_runtime_settings(default_runtime_settings())
      |> load_startup_runtime_settings()

    state = %{
      state
      | next_poll_due_at_ms: nil,
        poll_check_in_progress: false,
        tick_timer_ref: nil,
        tick_token: nil
    }

    state = schedule_startup_tick(state, opts)

    {:ok, state}
  end

  defp schedule_startup_tick(%State{} = state, opts) when is_list(opts) do
    case Keyword.get(opts, :startup_poll_delay_ms, 0) do
      :manual ->
        state

      delay_ms when is_integer(delay_ms) and delay_ms >= 0 ->
        schedule_tick(state, delay_ms)

      _ ->
        schedule_tick(state, 0)
    end
  end

  defp load_startup_runtime_settings(%State{} = state) do
    case Config.settings() do
      {:ok, settings} ->
        run_terminal_workspace_cleanup(settings.tracker.terminal_states)
        apply_runtime_settings(state, settings)

      {:error, reason} ->
        Logger.warning("Config load failed during init: #{inspect(reason)}; starting with defaults")
        state
    end
  end

  defp apply_runtime_settings(%State{} = state, settings) do
    %{
      state
      | poll_interval_ms: settings.polling.interval_ms,
        max_concurrent_agents: settings.agent.max_concurrent_agents,
        max_retry_backoff_ms: settings.agent.max_retry_backoff_ms,
        worker_ssh_hosts: settings.worker.ssh_hosts,
        worker_max_concurrent_agents_per_host: settings.worker.max_concurrent_agents_per_host,
        active_states: normalize_issue_states(settings.tracker.active_states),
        terminal_states: normalize_issue_states(settings.tracker.terminal_states),
        dispatch_settings: settings.tracker.dispatch
    }
  end

  defp default_runtime_settings do
    {:ok, settings} = Schema.parse(%{})
    settings
  end

  defp normalize_issue_states(states) when is_list(states) do
    states
    |> Enum.map(&Schema.normalize_issue_state/1)
    |> Enum.filter(&(&1 != ""))
    |> MapSet.new()
  end

  defp normalize_issue_states(_states), do: MapSet.new()

  defp current_or_default_runtime_settings do
    case Config.settings() do
      {:ok, settings} -> settings
      {:error, _reason} -> default_runtime_settings()
    end
  end

  @impl true
  def handle_info({:tick, tick_token}, %{tick_token: tick_token} = state)
      when is_reference(tick_token) do
    state = refresh_runtime_config(state)

    state = %{
      state
      | poll_check_in_progress: true,
        next_poll_due_at_ms: nil,
        tick_timer_ref: nil,
        tick_token: nil
    }

    notify_dashboard()
    :ok = schedule_poll_cycle_start()
    {:noreply, state}
  end

  def handle_info({:tick, _tick_token}, state), do: {:noreply, state}

  def handle_info(:run_poll_cycle, state) do
    state = refresh_runtime_config(state)
    state = maybe_dispatch(state)
    state = schedule_tick(state, state.poll_interval_ms)
    state = %{state | poll_check_in_progress: false}

    notify_dashboard()
    {:noreply, state}
  end

  def handle_info(
        {:DOWN, ref, :process, _pid, reason},
        %{running: running} = state
      ) do
    case find_slot_for_ref(running, ref) do
      nil ->
        {:noreply, state}

      {issue_id, slot_index} = slot_key ->
        {running_entry, state} = pop_running_entry(state, slot_key)
        state = record_session_completion_totals(state, running_entry)
        session_id = running_entry_session_id(running_entry)

        state =
          case reason do
            :normal ->
              Logger.info("Agent task completed for issue_id=#{issue_id} slot=#{slot_index} session_id=#{session_id}; scheduling active-state continuation check")

              state
              |> finalize_run_history(running_entry, :success)
              |> complete_issue(issue_id)
              |> schedule_issue_retry(issue_id, 1, %{
                identifier: running_entry.identifier,
                delay_type: :continuation,
                slot_index: slot_index,
                worker_host: Map.get(running_entry, :worker_host),
                workspace_path: Map.get(running_entry, :workspace_path)
              })

            _ ->
              Logger.warning("Agent task exited for issue_id=#{issue_id} slot=#{slot_index} session_id=#{session_id} reason=#{inspect(reason)}; scheduling retry")

              next_attempt = next_retry_attempt_from_running(running_entry)
              maybe_delete_resume_state(Map.get(running_entry, :workspace_path), Map.get(running_entry, :worker_host), issue_id)

              failure_reason = "agent exited: #{inspect(reason)}"

              state
              |> finalize_run_history(running_entry, :failed, failure_reason)
              |> schedule_issue_retry(issue_id, next_attempt, %{
                identifier: running_entry.identifier,
                error: failure_reason,
                slot_index: slot_index,
                worker_host: Map.get(running_entry, :worker_host),
                workspace_path: Map.get(running_entry, :workspace_path)
              })
          end

        Logger.info("Agent task finished for issue_id=#{issue_id} slot=#{slot_index} session_id=#{session_id} reason=#{inspect(reason)}")

        notify_dashboard()
        {:noreply, state}
    end
  end

  def handle_info({:worker_runtime_info, issue_id, runtime_info}, %{running: running} = state)
      when is_binary(issue_id) and is_map(runtime_info) do
    slot_index = Map.get(runtime_info, :slot_index, 0)
    slot_key = {issue_id, slot_index}

    case Map.get(running, slot_key) do
      nil ->
        {:noreply, state}

      running_entry ->
        if Map.get(running_entry, :workspace_path) == nil do
          updated_entry =
            running_entry
            |> maybe_put_runtime_value(:agent_kind, runtime_info[:agent_kind])
            |> maybe_put_runtime_value(:worker_host, runtime_info[:worker_host])
            |> maybe_put_runtime_value(:workspace_path, runtime_info[:workspace_path])

          state = update_run_history_from_running_entry(state, updated_entry)
          notify_dashboard()
          {:noreply, %{state | running: Map.put(running, slot_key, updated_entry)}}
        else
          {:noreply, state}
        end
    end
  end

  def handle_info(
        {:agent_worker_update, issue_id, %{event: _, timestamp: _} = update},
        %{running: running} = state
      ) do
    slot_index = Map.get(update, :slot_index, 0)
    slot_key = {issue_id, slot_index}

    case Map.get(running, slot_key) do
      nil ->
        {:noreply, state}

      running_entry ->
        {updated_running_entry, token_delta} = integrate_agent_update(running_entry, update)

        state =
          state
          |> apply_usage_token_delta(token_delta)
          |> apply_codex_rate_limits(update)
          |> update_run_history_from_running_entry(updated_running_entry)

        notify_dashboard()
        {:noreply, %{state | running: Map.put(running, slot_key, updated_running_entry)}}
    end
  end

  def handle_info(
        {:codex_worker_update, issue_id, %{event: _, timestamp: _} = update},
        state
      ) do
    handle_info({:agent_worker_update, issue_id, Map.put_new(update, :agent_kind, "codex")}, state)
  end

  def handle_info({:agent_worker_update, _issue_id, _update}, state), do: {:noreply, state}
  def handle_info({:codex_worker_update, _issue_id, _update}, state), do: {:noreply, state}

  def handle_info({:retry_issue, issue_id, retry_token}, state) do
    result =
      case pop_retry_attempt_state(state, issue_id, retry_token) do
        {:ok, attempt, metadata, state} -> handle_retry_issue(state, issue_id, attempt, metadata)
        :missing -> {:noreply, state}
      end

    notify_dashboard()
    result
  end

  def handle_info({:retry_issue, _issue_id}, state), do: {:noreply, state}

  def handle_info(msg, state) do
    Logger.debug("Orchestrator ignored message: #{inspect(msg)}")
    {:noreply, state}
  end

  defp maybe_dispatch(%State{} = state) do
    state =
      state
      |> reconcile_running_issues()
      |> Map.put(:blocked_dispatches, [])

    with :ok <- Config.validate(),
         {:ok, issues} <- Tracker.fetch_candidate_issues() do
      choose_issues(issues, state)
    else
      {:error, :missing_linear_api_token} ->
        Logger.error("Linear API token missing in WORKFLOW.md")
        state

      {:error, :missing_linear_project_slug} ->
        Logger.error("Linear project slug missing in WORKFLOW.md")
        state

      {:error, :missing_tracker_kind} ->
        Logger.error("Tracker kind missing in WORKFLOW.md")

        state

      {:error, {:unsupported_tracker_kind, kind}} ->
        Logger.error("Unsupported tracker kind in WORKFLOW.md: #{inspect(kind)}")

        state

      {:error, {:invalid_workflow_config, message}} ->
        Logger.error("Invalid WORKFLOW.md config: #{message}")
        state

      {:error, {:missing_workflow_file, path, reason}} ->
        Logger.error("Missing WORKFLOW.md at #{path}: #{inspect(reason)}")
        state

      {:error, :workflow_front_matter_not_a_map} ->
        Logger.error("Failed to parse WORKFLOW.md: workflow front matter must decode to a map")
        state

      {:error, {:workflow_parse_error, reason}} ->
        Logger.error("Failed to parse WORKFLOW.md: #{inspect(reason)}")
        state

      {:error, reason} ->
        Logger.error("Failed to fetch from Linear: #{inspect(reason)}")
        state
    end
  end

  defp reconcile_running_issues(%State{} = state) do
    state = reconcile_stalled_running_issues(state)

    running_ids =
      state.running
      |> Map.keys()
      |> Enum.map(&running_issue_id_from_key/1)
      |> Enum.uniq()

    if running_ids == [] do
      state
    else
      with :ok <- Config.validate(),
           {:ok, issues} <- Tracker.fetch_issue_states_by_ids(running_ids) do
        issues
        |> reconcile_running_issue_states(
          state,
          state_active_state_set(state),
          state_terminal_state_set(state)
        )
        |> reconcile_missing_running_issue_ids(running_ids, issues)
      else
        {:error, reason} ->
          Logger.debug("Failed to refresh running issue states: #{inspect(reason)}; keeping active workers")
          state
      end
    end
  end

  if Mix.env() == :test do
    @doc false
    @spec reconcile_issue_states_for_test([Issue.t()], term()) :: term()
    def reconcile_issue_states_for_test(issues, %State{} = state) when is_list(issues) do
      reconcile_running_issue_states(
        issues,
        state,
        state_active_state_set(state),
        state_terminal_state_set(state)
      )
    end

    def reconcile_issue_states_for_test(issues, state) when is_list(issues) do
      reconcile_running_issue_states(issues, state, active_state_set(), terminal_state_set())
    end

    @doc false
    @spec should_dispatch_issue_for_test(Issue.t(), term()) :: boolean()
    def should_dispatch_issue_for_test(%Issue{} = issue, %State{} = state) do
      active_states = state_active_state_set(state)
      terminal_states = state_terminal_state_set(state)

      issue_dispatch_eligible?(issue, state, active_states, terminal_states) and
        is_nil(dispatch_capacity_block_reason(issue, state))
    end

    @doc false
    @spec dispatch_capacity_block_reason_for_test(Issue.t(), term(), String.t() | nil) ::
            :global_concurrency_cap | :local_concurrency_cap | :worker_host_capacity | nil
    def dispatch_capacity_block_reason_for_test(
          %Issue{} = issue,
          %State{} = state,
          preferred_worker_host \\ nil
        ) do
      dispatch_capacity_block_reason(issue, state, preferred_worker_host)
    end

    @doc false
    @spec revalidate_issue_for_dispatch_for_test(Issue.t(), ([String.t()] -> term())) ::
            {:ok, Issue.t()} | {:skip, Issue.t() | :missing} | {:error, term()}
    def revalidate_issue_for_dispatch_for_test(%Issue{} = issue, issue_fetcher)
        when is_function(issue_fetcher, 1) do
      revalidate_issue_for_dispatch(
        issue,
        issue_fetcher,
        active_state_set(),
        terminal_state_set(),
        dispatch_settings()
      )
    end

    @doc false
    @spec sort_issues_for_dispatch_for_test([Issue.t()]) :: [Issue.t()]
    def sort_issues_for_dispatch_for_test(issues) when is_list(issues) do
      sort_issues_for_dispatch(issues)
    end

    @doc false
    @spec select_worker_host_for_test(term(), String.t() | nil) ::
            String.t() | nil | :no_worker_capacity
    def select_worker_host_for_test(%State{} = state, preferred_worker_host) do
      select_worker_host(state, preferred_worker_host)
    end
  end

  defp reconcile_running_issue_states([], state, _active_states, _terminal_states), do: state

  defp reconcile_running_issue_states([issue | rest], state, active_states, terminal_states) do
    reconcile_running_issue_states(
      rest,
      reconcile_issue_state(issue, state, active_states, terminal_states),
      active_states,
      terminal_states
    )
  end

  defp reconcile_issue_state(%Issue{} = issue, state, active_states, terminal_states) do
    cond do
      terminal_issue_state?(issue.state, terminal_states) ->
        Logger.info("Issue moved to terminal state: #{issue_context(issue)} state=#{issue.state}; stopping active agent")

        terminate_all_issue_slots(state, issue.id, true, :canceled, "issue moved to terminal state")

      !issue_routable_to_worker?(issue) ->
        Logger.info("Issue no longer routed to this worker: #{issue_context(issue)} assignee=#{inspect(issue.assignee_id)}; stopping active agent")

        terminate_all_issue_slots(state, issue.id, false, :canceled, "issue no longer routed to this worker")

      !issue_matches_dispatch_routes?(issue, state) ->
        Logger.info("Issue no longer matches dispatch routes for this worker: #{issue_context(issue)} labels=#{inspect(issue.labels)}; stopping active agent")

        terminate_all_issue_slots(state, issue.id, false, :canceled, "issue no longer matches dispatch routes")

      active_issue_state?(issue.state, active_states) ->
        refresh_running_issue_state(state, issue)

      true ->
        Logger.info("Issue moved to non-active state: #{issue_context(issue)} state=#{issue.state}; stopping active agent")

        terminate_all_issue_slots(state, issue.id, false, :canceled, "issue moved to non-active state")
    end
  end

  defp reconcile_issue_state(_issue, state, _active_states, _terminal_states), do: state

  defp reconcile_missing_running_issue_ids(%State{} = state, requested_issue_ids, issues)
       when is_list(requested_issue_ids) and is_list(issues) do
    visible_issue_ids =
      issues
      |> Enum.flat_map(fn
        %Issue{id: issue_id} when is_binary(issue_id) -> [issue_id]
        _ -> []
      end)
      |> MapSet.new()

    Enum.reduce(requested_issue_ids, state, fn issue_id, state_acc ->
      if MapSet.member?(visible_issue_ids, issue_id) do
        state_acc
      else
        log_missing_running_issue(state_acc, issue_id)
        terminate_all_issue_slots(state_acc, issue_id, false, :canceled, "issue no longer visible during refresh")
      end
    end)
  end

  defp reconcile_missing_running_issue_ids(state, _requested_issue_ids, _issues), do: state

  defp log_missing_running_issue(%State{} = state, issue_id) when is_binary(issue_id) do
    slots = running_slots_for_issue(state.running, issue_id)

    case Enum.at(Enum.to_list(slots), 0) do
      {_key, %{identifier: identifier}} ->
        Logger.info("Issue no longer visible during running-state refresh: issue_id=#{issue_id} issue_identifier=#{identifier}; stopping active agent")

      _ ->
        Logger.info("Issue no longer visible during running-state refresh: issue_id=#{issue_id}; stopping active agent")
    end
  end

  defp log_missing_running_issue(_state, _issue_id), do: :ok

  defp refresh_running_issue_state(%State{} = state, %Issue{} = issue) do
    slots = running_slots_for_issue(state.running, issue.id)

    if map_size(slots) == 0 do
      state
    else
      {updated_running, updated_entries} =
        Enum.reduce(slots, {state.running, []}, fn {slot_key, running_entry}, {acc_running, acc_entries} ->
          updated_entry = maybe_update_running_issue(running_entry, issue)
          {Map.put(acc_running, slot_key, updated_entry), [updated_entry | acc_entries]}
        end)

      state =
        Enum.reduce(updated_entries, %{state | running: updated_running}, fn entry, acc ->
          update_run_history_from_running_entry(acc, entry)
        end)

      state
    end
  end

  defp maybe_update_running_issue(%{issue: _} = running_entry, issue) do
    update_running_entry(running_entry, %{issue: issue})
  end

  defp maybe_update_running_issue(running_entry, _issue), do: running_entry

  defp terminate_all_issue_slots(
         %State{} = state,
         issue_id,
         cleanup_workspace,
         outcome,
         failure_reason
       ) do
    slots =
      state.running
      |> Enum.filter(fn {{id, _slot}, _} -> id == issue_id end)
      |> Enum.map(fn {{_id, slot}, _} -> slot end)

    if slots == [] do
      release_all_issue_claims(state, issue_id)
    else
      state =
        Enum.reduce(slots, state, fn slot_index, acc ->
          terminate_running_slot(acc, {issue_id, slot_index}, cleanup_workspace, outcome, failure_reason)
        end)

      %{state | retry_attempts: Map.delete(state.retry_attempts, issue_id)}
    end
  end

  defp terminate_running_slot(
         %State{} = state,
         {issue_id, _slot_index} = slot_key,
         cleanup_workspace,
         outcome,
         failure_reason
       ) do
    case Map.get(state.running, slot_key) do
      nil ->
        release_issue_claim(state, slot_key)

      %{pid: pid, ref: ref, identifier: identifier} = running_entry ->
        state = record_session_completion_totals(state, running_entry)
        state = finalize_run_history(state, running_entry, outcome, failure_reason)
        worker_host = Map.get(running_entry, :worker_host)

        if cleanup_workspace do
          cleanup_issue_workspace(identifier, worker_host)
        end

        if is_pid(pid) do
          terminate_task(pid)
        end

        if is_reference(ref) do
          Process.demonitor(ref, [:flush])
        end

        %{
          state
          | running: Map.delete(state.running, slot_key),
            claimed: MapSet.delete(state.claimed, slot_key),
            retry_attempts: Map.delete(state.retry_attempts, issue_id)
        }

      _ ->
        release_issue_claim(state, slot_key)
    end
  end

  defp reconcile_stalled_running_issues(%State{running: running} = state)
       when map_size(running) == 0,
       do: state

  defp reconcile_stalled_running_issues(%State{} = state) do
    case Config.settings() do
      {:ok, settings} ->
        now = DateTime.utc_now()

        Enum.reduce(state.running, state, fn {slot_key, running_entry}, state_acc ->
          reconcile_stalled_running_slot(state_acc, slot_key, running_entry, now, settings)
        end)

      {:error, reason} ->
        Logger.warning("Skipping stall reconciliation; config load failed: #{inspect(reason)}")
        state
    end
  end

  defp reconcile_stalled_running_slot(
         state,
         {issue_id, slot_index} = slot_key,
         running_entry,
         now,
         settings
       ) do
    timeout_ms =
      Map.get(running_entry, :stall_timeout_ms) ||
        agent_stall_timeout_ms(settings, Map.get(running_entry, :agent_kind))

    if timeout_ms <= 0,
      do: state,
      else: restart_stalled_issue(state, slot_key, issue_id, slot_index, running_entry, now, timeout_ms)
  end

  defp restart_stalled_issue(state, slot_key, issue_id, slot_index, running_entry, now, timeout_ms) do
    elapsed_ms = stall_elapsed_ms(running_entry, now)

    if is_integer(elapsed_ms) and elapsed_ms > timeout_ms do
      identifier = Map.get(running_entry, :identifier, issue_id)
      session_id = running_entry_session_id(running_entry)

      Logger.warning("Issue stalled: issue_id=#{issue_id} slot=#{slot_index} issue_identifier=#{identifier} session_id=#{session_id} elapsed_ms=#{elapsed_ms}; restarting with backoff")

      next_attempt = next_retry_attempt_from_running(running_entry)
      maybe_delete_resume_state(Map.get(running_entry, :workspace_path), Map.get(running_entry, :worker_host), issue_id)
      failure_reason = "stalled for #{elapsed_ms}ms without agent activity"

      state
      |> terminate_running_slot(slot_key, false, :stalled, failure_reason)
      |> schedule_issue_retry(issue_id, next_attempt, %{
        identifier: identifier,
        slot_index: slot_index,
        error: failure_reason
      })
    else
      state
    end
  end

  defp stall_elapsed_ms(running_entry, now) do
    running_entry
    |> last_activity_timestamp()
    |> case do
      %DateTime{} = timestamp ->
        max(0, DateTime.diff(now, timestamp, :millisecond))

      _ ->
        nil
    end
  end

  defp last_activity_timestamp(running_entry) when is_map(running_entry) do
    Map.get(running_entry, :last_agent_timestamp) ||
      Map.get(running_entry, :started_at)
  end

  defp terminate_task(pid) when is_pid(pid) do
    case Task.Supervisor.terminate_child(SymphonyElixir.TaskSupervisor, pid) do
      :ok ->
        :ok

      {:error, :not_found} ->
        Process.exit(pid, :shutdown)
    end
  end

  defp terminate_task(_pid), do: :ok

  defp choose_issues(issues, state) do
    active_states = state_active_state_set(state)
    terminal_states = state_terminal_state_set(state)

    {state, blocked_dispatches} =
      issues
      |> sort_issues_for_dispatch()
      |> Enum.reduce(
        {state, []},
        &accumulate_dispatch_decision(&1, &2, active_states, terminal_states)
      )

    %{state | blocked_dispatches: Enum.reverse(blocked_dispatches)}
  end

  defp accumulate_dispatch_decision(issue, {state_acc, blocked_acc}, active_states, terminal_states) do
    if issue_dispatch_eligible?(issue, state_acc, active_states, terminal_states) do
      case dispatch_capacity_block_reason(issue, state_acc) do
        nil ->
          {dispatch_issue(state_acc, issue), blocked_acc}

        reason ->
          log_dispatch_block(issue, state_acc, reason)
          {state_acc, [dispatch_block_entry(issue, reason) | blocked_acc]}
      end
    else
      {state_acc, blocked_acc}
    end
  end

  defp sort_issues_for_dispatch(issues) when is_list(issues) do
    Enum.sort_by(issues, fn
      %Issue{} = issue ->
        {priority_rank(issue.priority), issue_created_at_sort_key(issue), issue.identifier || issue.id || ""}

      _ ->
        {priority_rank(nil), issue_created_at_sort_key(nil), ""}
    end)
  end

  defp priority_rank(priority) when is_integer(priority) and priority in 1..4, do: priority
  defp priority_rank(_priority), do: 5

  defp issue_created_at_sort_key(%Issue{created_at: %DateTime{} = created_at}) do
    DateTime.to_unix(created_at, :microsecond)
  end

  defp issue_created_at_sort_key(%Issue{}), do: 9_223_372_036_854_775_807
  defp issue_created_at_sort_key(_issue), do: 9_223_372_036_854_775_807

  defp issue_dispatch_eligible?(%Issue{} = issue, %State{claimed: claimed} = state, active_states, terminal_states) do
    ensemble_size = resolve_ensemble_size(issue)

    candidate_issue?(issue, active_states, terminal_states) and
      issue_matches_dispatch_routes?(issue, state) and
      !unstarted_issue_blocked_by_non_terminal?(issue, terminal_states) and
      claimed_slot_count_for_issue(claimed, issue.id) < ensemble_size
  end

  defp issue_dispatch_eligible?(_issue, _state, _active_states, _terminal_states), do: false

  defp state_slots_available?(%Issue{state: issue_state}, %State{} = state) when is_binary(issue_state) do
    case local_max_concurrent_agents_for_state(state, issue_state) do
      limit when is_integer(limit) and limit > 0 ->
        used = running_issue_count_for_state(state.running, issue_state)
        limit > used

      _ ->
        true
    end
  end

  defp state_slots_available?(_issue, _state), do: false

  defp running_issue_count_for_state(running, issue_state) when is_map(running) do
    normalized_state = Schema.normalize_issue_state(issue_state)

    Enum.count(running, fn
      {_key, %{issue: %Issue{state: state_name}}} ->
        Schema.normalize_issue_state(state_name) == normalized_state

      _ ->
        false
    end)
  end

  defp candidate_issue?(
         %Issue{
           id: id,
           identifier: identifier,
           title: title,
           state: state_name
         } = issue,
         active_states,
         terminal_states
       )
       when is_binary(id) and is_binary(identifier) and is_binary(title) and is_binary(state_name) do
    issue_routable_to_worker?(issue) and
      active_issue_state?(state_name, active_states) and
      !terminal_issue_state?(state_name, terminal_states)
  end

  defp candidate_issue?(_issue, _active_states, _terminal_states), do: false

  defp issue_routable_to_worker?(%Issue{assigned_to_worker: assigned_to_worker})
       when is_boolean(assigned_to_worker),
       do: assigned_to_worker

  defp issue_routable_to_worker?(_issue), do: true

  defp unstarted_issue_blocked_by_non_terminal?(
         %Issue{state: issue_state, state_type: issue_state_type, blocked_by: blockers},
         terminal_states
       )
       when is_binary(issue_state) and is_list(blockers) do
    unstarted_issue_state?(issue_state, issue_state_type) and
      Enum.any?(blockers, fn
        %{state: blocker_state} when is_binary(blocker_state) ->
          !terminal_issue_state?(blocker_state, terminal_states)

        _ ->
          true
      end)
  end

  defp unstarted_issue_blocked_by_non_terminal?(_issue, _terminal_states), do: false

  defp unstarted_issue_state?(state_name, state_type) when is_binary(state_name) do
    case state_type do
      state_type when is_binary(state_type) -> Schema.normalize_issue_state(state_type) == "unstarted"
      _ -> Schema.normalize_issue_state(state_name) == "todo"
    end
  end

  defp terminal_issue_state?(state_name, terminal_states) when is_binary(state_name) do
    Enum.member?(terminal_states, Schema.normalize_issue_state(state_name))
  end

  defp terminal_issue_state?(_state_name, _terminal_states), do: false

  defp active_issue_state?(state_name, active_states) when is_binary(state_name) do
    Enum.member?(active_states, Schema.normalize_issue_state(state_name))
  end

  defp issue_matches_dispatch_routes?(%Issue{} = issue, %State{} = state) do
    TrackerDispatch.eligible?(issue, state_dispatch_settings(state))
  end

  defp issue_matches_dispatch_routes?(%Issue{} = issue, dispatch_settings) do
    TrackerDispatch.eligible?(issue, dispatch_settings)
  end

  defp state_dispatch_settings(%State{
         dispatch_settings:
           %{
             accept_unrouted: accept_unrouted,
             only_routes: only_routes,
             route_label_prefix: route_label_prefix
           } = dispatch_settings
       })
       when is_boolean(accept_unrouted) and (is_nil(only_routes) or is_list(only_routes)) and
              is_binary(route_label_prefix) do
    dispatch_settings
  end

  defp state_dispatch_settings(_state), do: dispatch_settings()

  defp state_terminal_state_set(%State{terminal_states: %MapSet{} = terminal_states}) do
    if MapSet.size(terminal_states) > 0, do: terminal_states, else: terminal_state_set()
  end

  defp state_terminal_state_set(_state), do: terminal_state_set()

  defp state_active_state_set(%State{active_states: %MapSet{} = active_states}) do
    if MapSet.size(active_states) > 0, do: active_states, else: active_state_set()
  end

  defp state_active_state_set(_state), do: active_state_set()

  defp terminal_state_set do
    current_or_default_runtime_settings().tracker.terminal_states
    |> normalize_issue_states()
  end

  defp active_state_set do
    current_or_default_runtime_settings().tracker.active_states
    |> normalize_issue_states()
  end

  defp dispatch_settings do
    current_or_default_runtime_settings().tracker.dispatch
  end

  defp dispatch_issue(%State{} = state, issue, attempt \\ nil, preferred_worker_host \\ nil) do
    case revalidate_issue_for_dispatch(
           issue,
           &Tracker.fetch_issue_states_by_ids/1,
           state_active_state_set(state),
           state_terminal_state_set(state),
           state_dispatch_settings(state)
         ) do
      {:ok, %Issue{} = refreshed_issue} ->
        do_dispatch_issue(state, refreshed_issue, attempt, preferred_worker_host)

      {:skip, :missing} ->
        Logger.info("Skipping dispatch; issue no longer active or visible: #{issue_context(issue)}")
        state

      {:skip, %Issue{} = refreshed_issue} ->
        Logger.info("Skipping stale dispatch after issue refresh: #{issue_context(refreshed_issue)} state=#{inspect(refreshed_issue.state)} blocked_by=#{length(refreshed_issue.blocked_by)}")

        state

      {:error, reason} ->
        Logger.warning("Skipping dispatch; issue refresh failed for #{issue_context(issue)}: #{inspect(reason)}")
        state
    end
  end

  defp do_dispatch_issue(%State{} = state, issue, attempt, preferred_worker_host) do
    ensemble_size = resolve_ensemble_size(issue)

    dispatched_slots =
      state.claimed
      |> Enum.filter(fn {id, _slot} -> id == issue.id end)
      |> Enum.map(fn {_id, slot} -> slot end)
      |> MapSet.new()

    all_slots = MapSet.new(0..(ensemble_size - 1))
    remaining = MapSet.difference(all_slots, dispatched_slots)
    slots_to_fill = remaining |> Enum.sort() |> Enum.take(max(available_slots(state), 0))

    Enum.reduce(slots_to_fill, state, fn slot_index, acc_state ->
      case select_worker_host(acc_state, preferred_worker_host) do
        :no_worker_capacity ->
          Logger.debug("No SSH worker slots available for #{issue_context(issue)} slot=#{slot_index} preferred_worker_host=#{inspect(preferred_worker_host)}")
          acc_state

        worker_host ->
          spawn_issue_slot(acc_state, issue, slot_index, ensemble_size, attempt, worker_host)
      end
    end)
  end

  defp spawn_issue_slot(%State{} = state, issue, slot_index, ensemble_size, attempt, worker_host) do
    recipient = self()
    runtime_settings = runtime_settings_for_issue_state(issue.state)
    started_at = DateTime.utc_now()

    {state, run_record} =
      append_run_history(state, %{
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        issue_title: issue.title,
        state: issue.state,
        slot_index: slot_index,
        ensemble_size: ensemble_size,
        agent_kind: runtime_settings.agent.kind,
        worker_host: worker_host,
        workspace_path: nil,
        run_id: nil,
        resume_id: nil,
        session_id: nil,
        executor_pid: nil,
        usage_totals: @empty_usage_totals,
        turn_count: 0,
        retry_attempt: normalize_retry_attempt(attempt),
        last_agent_timestamp: nil,
        last_agent_event: nil,
        last_agent_message: nil,
        started_at: started_at,
        ended_at: nil,
        outcome: :running,
        failure_reason: nil,
        cost: @empty_cost_summary
      })

    case Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
           AgentRunner.run(issue, recipient,
             attempt: attempt,
             runtime_settings: runtime_settings,
             worker_host: worker_host,
             slot_index: slot_index,
             ensemble_size: ensemble_size
           )
         end) do
      {:ok, pid} ->
        ref = Process.monitor(pid)
        slot_key = {issue.id, slot_index}

        Logger.info("Dispatching issue to agent: #{issue_context(issue)} slot=#{slot_index}/#{ensemble_size} pid=#{inspect(pid)} attempt=#{inspect(attempt)} worker_host=#{worker_host || "local"}")

        running =
          Map.put(
            state.running,
            slot_key,
            RunningEntry.new(%{
              pid: pid,
              ref: ref,
              run_id: run_record.id,
              agent_kind: runtime_settings.agent.kind,
              identifier: issue.identifier,
              issue: issue,
              slot_index: slot_index,
              ensemble_size: ensemble_size,
              worker_host: worker_host,
              stall_timeout_ms: agent_stall_timeout_ms(runtime_settings, runtime_settings.agent.kind),
              retry_attempt: normalize_retry_attempt(attempt),
              started_at: started_at
            })
          )

        %{
          state
          | running: running,
            claimed: MapSet.put(state.claimed, slot_key),
            retry_attempts: Map.delete(state.retry_attempts, issue.id)
        }

      {:error, reason} ->
        Logger.error("Unable to spawn agent for #{issue_context(issue)} slot=#{slot_index}: #{inspect(reason)}")
        next_attempt = if is_integer(attempt), do: attempt + 1, else: nil
        failure_reason = "failed to spawn agent: #{inspect(reason)}"

        state
        |> finalize_run_history(run_record, :failed, failure_reason)
        |> schedule_issue_retry(issue.id, next_attempt, %{
          identifier: issue.identifier,
          slot_index: slot_index,
          error: failure_reason,
          worker_host: worker_host
        })
    end
  end

  defp revalidate_issue_for_dispatch(
         %Issue{id: issue_id},
         issue_fetcher,
         active_states,
         terminal_states,
         dispatch_settings
       )
       when is_binary(issue_id) and is_function(issue_fetcher, 1) do
    case issue_fetcher.([issue_id]) do
      {:ok, [%Issue{} = refreshed_issue | _]} ->
        if retry_candidate_issue?(refreshed_issue, active_states, terminal_states, dispatch_settings) do
          {:ok, refreshed_issue}
        else
          {:skip, refreshed_issue}
        end

      {:ok, []} ->
        {:skip, :missing}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp revalidate_issue_for_dispatch(
         issue,
         _issue_fetcher,
         _active_states,
         _terminal_states,
         _dispatch_settings
       ),
       do: {:ok, issue}

  defp complete_issue(%State{} = state, issue_id) do
    %{
      state
      | completed: MapSet.put(state.completed, issue_id),
        retry_attempts: Map.delete(state.retry_attempts, issue_id)
    }
  end

  defp schedule_issue_retry(%State{} = state, issue_id, attempt, metadata)
       when is_binary(issue_id) and is_map(metadata) do
    previous_retry = Map.get(state.retry_attempts, issue_id, %{attempt: 0})
    next_attempt = if is_integer(attempt), do: attempt, else: previous_retry.attempt + 1
    delay_ms = retry_delay(next_attempt, metadata, state)
    old_timer = Map.get(previous_retry, :timer_ref)
    retry_token = make_ref()
    due_at_ms = System.monotonic_time(:millisecond) + delay_ms
    identifier = pick_retry_identifier(issue_id, previous_retry, metadata)
    error = pick_retry_error(previous_retry, metadata)
    worker_host = pick_retry_worker_host(previous_retry, metadata)
    workspace_path = pick_retry_workspace_path(previous_retry, metadata)

    if is_reference(old_timer) do
      Process.cancel_timer(old_timer)
    end

    timer_ref = Process.send_after(self(), {:retry_issue, issue_id, retry_token}, delay_ms)

    error_suffix = if is_binary(error), do: " error=#{error}", else: ""

    Logger.warning("Retrying issue_id=#{issue_id} issue_identifier=#{identifier} in #{delay_ms}ms (attempt #{next_attempt})#{error_suffix}")

    %{
      state
      | retry_attempts:
          Map.put(state.retry_attempts, issue_id, %{
            attempt: next_attempt,
            timer_ref: timer_ref,
            retry_token: retry_token,
            due_at_ms: due_at_ms,
            identifier: identifier,
            error: error,
            worker_host: worker_host,
            workspace_path: workspace_path
          })
    }
  end

  defp pop_retry_attempt_state(%State{} = state, issue_id, retry_token) when is_reference(retry_token) do
    case Map.get(state.retry_attempts, issue_id) do
      %{attempt: attempt, retry_token: ^retry_token} = retry_entry ->
        metadata = %{
          identifier: Map.get(retry_entry, :identifier),
          error: Map.get(retry_entry, :error),
          worker_host: Map.get(retry_entry, :worker_host),
          workspace_path: Map.get(retry_entry, :workspace_path)
        }

        {:ok, attempt, metadata, %{state | retry_attempts: Map.delete(state.retry_attempts, issue_id)}}

      _ ->
        :missing
    end
  end

  defp handle_retry_issue(%State{} = state, issue_id, attempt, metadata) do
    with :ok <- Config.validate(),
         {:ok, issues} <- Tracker.fetch_candidate_issues() do
      issues
      |> find_issue_by_id(issue_id)
      |> handle_retry_issue_lookup(state, issue_id, attempt, metadata)
    else
      {:error, reason} ->
        Logger.warning("Retry poll failed for issue_id=#{issue_id} issue_identifier=#{metadata[:identifier] || issue_id}: #{inspect(reason)}")

        {:noreply,
         schedule_issue_retry(
           state,
           issue_id,
           attempt + 1,
           Map.merge(metadata, %{error: "retry poll failed: #{inspect(reason)}"})
         )}
    end
  end

  defp handle_retry_issue_lookup(%Issue{} = issue, state, issue_id, attempt, metadata) do
    terminal_states = state_terminal_state_set(state)

    cond do
      terminal_issue_state?(issue.state, terminal_states) ->
        Logger.info("Issue state is terminal: issue_id=#{issue_id} issue_identifier=#{issue.identifier} state=#{issue.state}; removing associated workspace")

        cleanup_issue_workspace(issue.identifier, metadata[:worker_host])
        {:noreply, release_all_issue_claims(state, issue_id)}

      retry_candidate_issue?(
        issue,
        state_active_state_set(state),
        terminal_states,
        state_dispatch_settings(state)
      ) ->
        handle_active_retry(state, issue, attempt, metadata)

      true ->
        Logger.debug("Issue left active states, removing claim issue_id=#{issue_id} issue_identifier=#{issue.identifier}")

        {:noreply, release_all_issue_claims(state, issue_id)}
    end
  end

  defp handle_retry_issue_lookup(nil, state, issue_id, _attempt, _metadata) do
    Logger.debug("Issue no longer visible, removing claim issue_id=#{issue_id}")
    {:noreply, release_all_issue_claims(state, issue_id)}
  end

  defp cleanup_issue_workspace(identifier, worker_host \\ nil)

  defp cleanup_issue_workspace(identifier, worker_host) when is_binary(identifier) do
    Workspace.remove_issue_workspaces(identifier, worker_host)
  end

  defp cleanup_issue_workspace(_identifier, _worker_host), do: :ok

  defp run_terminal_workspace_cleanup(terminal_states) when is_list(terminal_states) do
    case Tracker.fetch_issues_by_states(terminal_states) do
      {:ok, issues} ->
        issues
        |> Enum.each(fn
          %Issue{identifier: identifier} when is_binary(identifier) ->
            cleanup_issue_workspace(identifier)

          _ ->
            :ok
        end)

      {:error, reason} ->
        Logger.warning("Skipping startup terminal workspace cleanup; failed to fetch terminal issues: #{inspect(reason)}")
    end
  end

  defp run_terminal_workspace_cleanup(_terminal_states), do: :ok

  defp notify_dashboard do
    StatusDashboard.notify_update()
  end

  defp handle_active_retry(state, issue, attempt, metadata) do
    state = release_orphaned_issue_claims(state, issue.id)

    retry_candidate? =
      retry_candidate_issue?(
        issue,
        state_active_state_set(state),
        state_terminal_state_set(state),
        state_dispatch_settings(state)
      )

    block_reason =
      if retry_candidate? do
        dispatch_capacity_block_reason(issue, state, metadata[:worker_host])
      end

    if retry_candidate? and is_nil(block_reason) do
      {:noreply, dispatch_issue(state, issue, attempt, metadata[:worker_host])}
    else
      if block_reason do
        log_dispatch_block(issue, state, block_reason, metadata[:worker_host])
      else
        Logger.debug("No available slots for retrying #{issue_context(issue)}; retrying again")
      end

      {:noreply,
       schedule_issue_retry(
         state,
         issue.id,
         attempt + 1,
         Map.merge(metadata, %{
           identifier: issue.identifier,
           error: dispatch_block_error(block_reason)
         })
       )}
    end
  end

  defp release_issue_claim(%State{} = state, {_issue_id, _slot_index} = slot_key) do
    %{state | claimed: MapSet.delete(state.claimed, slot_key)}
  end

  defp release_orphaned_issue_claims(%State{} = state, issue_id) when is_binary(issue_id) do
    claimed =
      Enum.reduce(state.claimed, state.claimed, fn
        {id, _slot} = key, acc when id == issue_id ->
          if Map.has_key?(state.running, key), do: acc, else: MapSet.delete(acc, key)

        _claim, acc ->
          acc
      end)

    %{state | claimed: claimed}
  end

  defp release_orphaned_issue_claims(%State{} = state, _issue_id), do: state

  defp release_all_issue_claims(%State{} = state, issue_id) when is_binary(issue_id) do
    claimed =
      Enum.reduce(state.claimed, state.claimed, fn
        {id, _slot} = key, acc when id == issue_id -> MapSet.delete(acc, key)
        _, acc -> acc
      end)

    %{state | claimed: claimed, retry_attempts: Map.delete(state.retry_attempts, issue_id)}
  end

  defp retry_delay(attempt, metadata, state)
       when is_integer(attempt) and attempt > 0 and is_map(metadata) do
    if metadata[:delay_type] == :continuation and attempt == 1 do
      @continuation_retry_delay_ms
    else
      failure_retry_delay(attempt, state)
    end
  end

  defp failure_retry_delay(attempt, %State{} = state) do
    max_delay_power = min(attempt - 1, 10)

    max_retry_backoff_ms =
      state.max_retry_backoff_ms || current_or_default_runtime_settings().agent.max_retry_backoff_ms ||
        @default_max_retry_backoff_ms

    min(@failure_retry_base_ms * (1 <<< max_delay_power), max_retry_backoff_ms)
  end

  defp normalize_retry_attempt(attempt) when is_integer(attempt) and attempt > 0, do: attempt
  defp normalize_retry_attempt(_attempt), do: 0

  defp next_retry_attempt_from_running(running_entry) do
    case Map.get(running_entry, :retry_attempt) do
      attempt when is_integer(attempt) and attempt > 0 -> attempt + 1
      _ -> nil
    end
  end

  defp pick_retry_identifier(issue_id, previous_retry, metadata) do
    metadata[:identifier] || Map.get(previous_retry, :identifier) || issue_id
  end

  defp pick_retry_error(previous_retry, metadata) do
    metadata[:error] || Map.get(previous_retry, :error)
  end

  defp pick_retry_worker_host(previous_retry, metadata) do
    metadata[:worker_host] || Map.get(previous_retry, :worker_host)
  end

  defp maybe_delete_resume_state(workspace, worker_host, issue_id)
       when is_binary(workspace) and workspace != "" do
    case AgentResumeState.delete(workspace, worker_host) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to delete resume state for issue_id=#{issue_id} workspace=#{workspace}: #{inspect(reason)}")
        :ok
    end
  end

  defp maybe_delete_resume_state(_workspace, _worker_host, _issue_id), do: :ok

  defp pick_retry_workspace_path(previous_retry, metadata) do
    metadata[:workspace_path] || Map.get(previous_retry, :workspace_path)
  end

  defp maybe_put_runtime_value(running_entry, _key, nil), do: running_entry

  defp maybe_put_runtime_value(running_entry, key, value) when is_map(running_entry) do
    update_running_entry(running_entry, %{key => value})
  end

  defp local_max_concurrent_agents_for_state(%State{} = _state, state_name) when is_binary(state_name) do
    Config.local_max_concurrent_agents_for_state(state_name)
  end

  defp local_max_concurrent_agents_for_state(_state, _state_name), do: nil

  defp configured_worker_hosts(%State{worker_ssh_hosts: hosts}) when is_list(hosts) and hosts != [],
    do: hosts

  defp configured_worker_hosts(_state), do: current_or_default_runtime_settings().worker.ssh_hosts

  defp select_worker_host(%State{} = state, preferred_worker_host) do
    case configured_worker_hosts(state) do
      [] ->
        nil

      hosts ->
        available_hosts = Enum.filter(hosts, &worker_host_slots_available?(state, &1))

        cond do
          available_hosts == [] ->
            :no_worker_capacity

          preferred_worker_host_available?(preferred_worker_host, available_hosts) ->
            preferred_worker_host

          true ->
            least_loaded_worker_host(state, available_hosts)
        end
    end
  end

  defp preferred_worker_host_available?(preferred_worker_host, hosts)
       when is_binary(preferred_worker_host) and is_list(hosts) do
    preferred_worker_host != "" and preferred_worker_host in hosts
  end

  defp preferred_worker_host_available?(_preferred_worker_host, _hosts), do: false

  defp least_loaded_worker_host(%State{} = state, hosts) when is_list(hosts) do
    hosts
    |> Enum.with_index()
    |> Enum.min_by(fn {host, index} ->
      {running_worker_host_count(state.running, host), index}
    end)
    |> elem(0)
  end

  defp running_worker_host_count(running, worker_host) when is_map(running) and is_binary(worker_host) do
    Enum.count(running, fn
      {_key, %{worker_host: ^worker_host}} -> true
      _ -> false
    end)
  end

  defp worker_slots_available?(%State{} = state, preferred_worker_host) do
    select_worker_host(state, preferred_worker_host) != :no_worker_capacity
  end

  defp worker_host_slots_available?(%State{} = state, worker_host) when is_binary(worker_host) do
    case state.worker_max_concurrent_agents_per_host ||
           current_or_default_runtime_settings().worker.max_concurrent_agents_per_host do
      limit when is_integer(limit) and limit > 0 ->
        running_worker_host_count(state.running, worker_host) < limit

      _ ->
        true
    end
  end

  defp find_issue_by_id(issues, issue_id) when is_binary(issue_id) do
    Enum.find(issues, fn
      %Issue{id: ^issue_id} ->
        true

      _ ->
        false
    end)
  end

  defp find_slot_for_ref(running, ref) do
    Enum.find_value(running, fn {{issue_id, slot_index}, entry} ->
      if RunningEntry.ref_matches?(entry, ref), do: {issue_id, slot_index}
    end)
  end

  defp running_slots_for_issue(running, issue_id) do
    running
    |> Enum.filter(fn {{id, _slot}, _entry} -> id == issue_id end)
    |> Map.new()
  end

  defp claimed_slot_count_for_issue(claimed, issue_id) do
    Enum.count(claimed, fn {id, _slot} -> id == issue_id end)
  end

  defp resolve_ensemble_size(issue) do
    case Issue.ensemble_size(issue) do
      n when is_integer(n) and n >= 1 -> n
      _ -> runtime_settings_for_issue_state(Map.get(issue, :state)).agent.ensemble_size
    end
  end

  defp running_entry_session_id(%{session_id: session_id}) when is_binary(session_id),
    do: session_id

  defp running_entry_session_id(_running_entry), do: "n/a"

  defp issue_context(%Issue{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end

  defp available_slots(%State{} = state) do
    max(
      (state.max_concurrent_agents || current_or_default_runtime_settings().agent.max_concurrent_agents) -
        map_size(state.running),
      0
    )
  end

  defp dispatch_capacity_block_reason(%Issue{} = issue, %State{} = state, preferred_worker_host \\ nil) do
    cond do
      available_slots(state) <= 0 ->
        :global_concurrency_cap

      not state_slots_available?(issue, state) ->
        :local_concurrency_cap

      not worker_slots_available?(state, preferred_worker_host) ->
        :worker_host_capacity

      true ->
        nil
    end
  end

  defp log_dispatch_block(%Issue{} = issue, %State{} = state, reason, preferred_worker_host \\ nil) do
    case reason do
      :global_concurrency_cap ->
        Logger.debug(
          "Dispatch blocked by global concurrency cap: #{issue_context(issue)} state=#{inspect(issue.state)} running=#{map_size(state.running)} max_concurrent_agents=#{state.max_concurrent_agents || current_or_default_runtime_settings().agent.max_concurrent_agents}"
        )

      :local_concurrency_cap ->
        Logger.debug(
          "Dispatch blocked by local concurrency cap: #{issue_context(issue)} state=#{inspect(issue.state)} running_in_state=#{running_issue_count_for_state(state.running, issue.state)} local_max_concurrent_agents=#{local_max_concurrent_agents_for_state(state, issue.state)}"
        )

      :worker_host_capacity ->
        Logger.debug(
          "Dispatch blocked by worker host capacity: #{issue_context(issue)} state=#{inspect(issue.state)} preferred_worker_host=#{inspect(preferred_worker_host)} worker_hosts=#{inspect(configured_worker_hosts(state))}"
        )
    end
  end

  defp dispatch_block_entry(%Issue{} = issue, reason) do
    %{
      issue_id: issue.id,
      identifier: issue.identifier,
      state: issue.state,
      reason: reason
    }
  end

  defp dispatch_block_error(nil), do: "no available orchestrator slots"
  defp dispatch_block_error(:global_concurrency_cap), do: "dispatch blocked by global concurrency cap"
  defp dispatch_block_error(:local_concurrency_cap), do: "dispatch blocked by local concurrency cap"
  defp dispatch_block_error(:worker_host_capacity), do: "dispatch blocked by worker host capacity"

  defp runtime_settings_for_issue_state(state_name) do
    case Config.settings_for_issue_state(state_name) do
      {:ok, settings} -> settings
      {:error, _reason} -> current_or_default_runtime_settings()
    end
  end

  @spec request_refresh() :: map() | :unavailable
  def request_refresh do
    request_refresh(__MODULE__)
  end

  @spec request_refresh(GenServer.server()) :: map() | :unavailable
  def request_refresh(server) do
    if Process.whereis(server) do
      GenServer.call(server, :request_refresh)
    else
      :unavailable
    end
  end

  @spec snapshot() :: map() | :timeout | :unavailable
  def snapshot, do: snapshot(__MODULE__, 15_000)

  @spec snapshot(GenServer.server(), timeout()) :: map() | :timeout | :unavailable
  def snapshot(server, timeout) do
    if Process.whereis(server) do
      try do
        GenServer.call(server, :snapshot, timeout)
      catch
        :exit, {:timeout, _} -> :timeout
        :exit, _ -> :unavailable
      end
    else
      :unavailable
    end
  end

  @impl true
  def handle_call(:snapshot, _from, state) do
    state = refresh_runtime_config(state)
    now = DateTime.utc_now()
    now_ms = System.monotonic_time(:millisecond)

    running =
      state.running
      |> Enum.map(&snapshot_running_entry(&1, now))

    retrying =
      state.retry_attempts
      |> Enum.map(fn {issue_id, %{attempt: attempt, due_at_ms: due_at_ms} = retry} ->
        %{
          issue_id: issue_id,
          attempt: attempt,
          due_in_ms: max(0, due_at_ms - now_ms),
          identifier: Map.get(retry, :identifier),
          error: Map.get(retry, :error),
          worker_host: Map.get(retry, :worker_host),
          workspace_path: Map.get(retry, :workspace_path)
        }
      end)

    blocked =
      Enum.map(state.blocked_dispatches, fn blocked_entry ->
        %{
          issue_id: blocked_entry.issue_id,
          identifier: blocked_entry.identifier,
          state: blocked_entry.state,
          reason: blocked_entry.reason
        }
      end)

    run_history =
      state.run_history
      |> Enum.map(&snapshot_run_record(&1, now))

    {:reply,
     %{
       running: running,
       retrying: retrying,
       blocked: blocked,
       run_history: run_history,
       usage_totals: state.usage_totals,
       rate_limits: Map.get(state, :codex_rate_limits),
       polling: %{
         checking?: state.poll_check_in_progress == true,
         next_poll_in_ms: next_poll_in_ms(state.next_poll_due_at_ms, now_ms),
         poll_interval_ms: state.poll_interval_ms
       }
     }, state}
  end

  def handle_call(:request_refresh, _from, state) do
    now_ms = System.monotonic_time(:millisecond)
    already_due? = is_integer(state.next_poll_due_at_ms) and state.next_poll_due_at_ms <= now_ms
    coalesced = state.poll_check_in_progress == true or already_due?
    state = if coalesced, do: state, else: schedule_tick(state, 0)

    {:reply,
     %{
       queued: true,
       coalesced: coalesced,
       requested_at: DateTime.utc_now(),
       operations: ["poll", "reconcile"]
     }, state}
  end

  defp snapshot_running_entry({{issue_id, slot_index}, metadata}, now) when is_map(metadata) do
    usage_totals = Map.get(metadata, :usage_totals, @empty_usage_totals)

    %{
      issue_id: issue_id,
      slot_index: slot_index,
      ensemble_size: Map.get(metadata, :ensemble_size, 1),
      identifier: metadata.identifier,
      agent_kind: Map.get(metadata, :agent_kind, "codex"),
      state: metadata.issue.state,
      worker_host: Map.get(metadata, :worker_host),
      workspace_path: Map.get(metadata, :workspace_path),
      run_id: Map.get(metadata, :run_id),
      resume_id: Map.get(metadata, :resume_id),
      session_id: metadata.session_id,
      executor_pid: Map.get(metadata, :executor_pid),
      usage_totals: usage_totals,
      last_agent_timestamp: Map.get(metadata, :last_agent_timestamp),
      last_agent_message: Map.get(metadata, :last_agent_message),
      last_agent_event: Map.get(metadata, :last_agent_event),
      turn_count: Map.get(metadata, :turn_count, 0),
      started_at: metadata.started_at,
      runtime_seconds: running_seconds(metadata.started_at, now)
    }
  end

  defp snapshot_running_entry({issue_id, metadata}, now) when is_binary(issue_id) and is_map(metadata) do
    snapshot_running_entry({{issue_id, 0}, metadata}, now)
  end

  defp running_issue_id_from_key({issue_id, _slot}) when is_binary(issue_id), do: issue_id
  defp running_issue_id_from_key(issue_id) when is_binary(issue_id), do: issue_id

  defp integrate_agent_update(running_entry, %{event: event, timestamp: timestamp} = update) do
    token_delta = extract_token_delta(running_entry, update)
    usage_totals = apply_token_delta(Map.get(running_entry, :usage_totals, @empty_usage_totals), token_delta)
    executor_pid = Map.get(running_entry, :executor_pid)
    last_reported_input = Map.get(running_entry, :usage_last_reported_input_tokens, 0)
    last_reported_output = Map.get(running_entry, :usage_last_reported_output_tokens, 0)
    last_reported_total = Map.get(running_entry, :usage_last_reported_total_tokens, 0)
    turn_count = Map.get(running_entry, :turn_count, 0)
    summary = summarize_agent_update(update)

    {
      update_running_entry(running_entry, %{
        agent_kind: Map.get(update, :agent_kind, Map.get(running_entry, :agent_kind, "codex")),
        last_agent_timestamp: timestamp,
        last_agent_message: summary,
        resume_id: resume_id_for_update(Map.get(running_entry, :resume_id), update),
        session_id: session_id_for_update(running_entry.session_id, update),
        last_agent_event: event,
        executor_pid: executor_pid_for_update(executor_pid, update),
        usage_totals: usage_totals,
        usage_last_reported_input_tokens: max(last_reported_input, token_delta.input_reported),
        usage_last_reported_output_tokens: max(last_reported_output, token_delta.output_reported),
        usage_last_reported_total_tokens: max(last_reported_total, token_delta.total_reported),
        turn_count: turn_count_for_update(turn_count, running_entry.session_id, update)
      }),
      token_delta
    }
  end

  defp update_running_entry(%RunningEntry{} = running_entry, attrs) when is_map(attrs) do
    struct(running_entry, attrs)
  end

  defp update_running_entry(running_entry, attrs) when is_map(running_entry) and is_map(attrs) do
    Map.merge(running_entry, attrs)
  end

  defp executor_pid_for_update(_existing, %{executor_pid: pid}) when is_binary(pid), do: pid
  defp executor_pid_for_update(_existing, %{executor_pid: pid}) when is_integer(pid), do: Integer.to_string(pid)
  defp executor_pid_for_update(_existing, %{executor_pid: pid}) when is_list(pid), do: to_string(pid)

  defp executor_pid_for_update(existing, _update), do: existing

  defp resume_id_for_update(_existing, %{resume_id: resume_id}) when is_binary(resume_id),
    do: resume_id

  defp resume_id_for_update(existing, _update), do: existing

  defp session_id_for_update(_existing, %{session_id: session_id}) when is_binary(session_id),
    do: session_id

  defp session_id_for_update(existing, _update), do: existing

  defp turn_count_for_update(existing_count, existing_session_id, %{
         event: :session_started,
         session_id: session_id
       })
       when is_integer(existing_count) and is_binary(session_id) do
    if session_id == existing_session_id do
      existing_count
    else
      existing_count + 1
    end
  end

  defp turn_count_for_update(existing_count, _existing_session_id, %{event: :turn_started})
       when is_integer(existing_count),
       do: existing_count + 1

  defp turn_count_for_update(existing_count, _existing_session_id, _update)
       when is_integer(existing_count),
       do: existing_count

  defp turn_count_for_update(_existing_count, _existing_session_id, _update), do: 0

  defp summarize_agent_update(update) do
    %{
      event: update[:event],
      message: update[:payload] || update[:raw],
      timestamp: update[:timestamp],
      agent_kind: update[:agent_kind] || "codex"
    }
  end

  defp schedule_tick(%State{} = state, delay_ms) when is_integer(delay_ms) and delay_ms >= 0 do
    if is_reference(state.tick_timer_ref) do
      Process.cancel_timer(state.tick_timer_ref)
    end

    tick_token = make_ref()
    timer_ref = Process.send_after(self(), {:tick, tick_token}, delay_ms)

    %{
      state
      | tick_timer_ref: timer_ref,
        tick_token: tick_token,
        next_poll_due_at_ms: System.monotonic_time(:millisecond) + delay_ms
    }
  end

  defp schedule_poll_cycle_start do
    Process.send_after(self(), :run_poll_cycle, @poll_transition_render_delay_ms)
    :ok
  end

  defp next_poll_in_ms(nil, _now_ms), do: nil

  defp next_poll_in_ms(next_poll_due_at_ms, now_ms) when is_integer(next_poll_due_at_ms) do
    max(0, next_poll_due_at_ms - now_ms)
  end

  defp pop_running_entry(state, {_issue_id, _slot_index} = slot_key) do
    {entry, running} = Map.pop(state.running, slot_key)
    {entry, %{state | running: running}}
  end

  defp append_run_history(%State{} = state, attrs) when is_map(attrs) do
    run_id = "run-#{state.next_run_id}"
    run_record = Map.put(attrs, :id, run_id)
    {%{state | next_run_id: state.next_run_id + 1, run_history: [run_record | state.run_history]}, run_record}
  end

  defp update_run_history_from_running_entry(%State{} = state, running_entry) when is_map(running_entry) do
    case Map.get(running_entry, :run_id) do
      run_id when is_binary(run_id) ->
        update_run_history(state, run_id, fn record ->
          record
          |> Map.put(
            :agent_kind,
            Map.get(running_entry, :agent_kind, Map.get(record, :agent_kind, "codex"))
          )
          |> Map.put(:state, run_state_for_history(running_entry, record))
          |> Map.put(:worker_host, Map.get(running_entry, :worker_host))
          |> Map.put(:workspace_path, Map.get(running_entry, :workspace_path))
          |> Map.put(:resume_id, Map.get(running_entry, :resume_id))
          |> Map.put(:session_id, Map.get(running_entry, :session_id))
          |> Map.put(:executor_pid, Map.get(running_entry, :executor_pid))
          |> Map.put(:usage_totals, Map.get(running_entry, :usage_totals, @empty_usage_totals))
          |> Map.put(:turn_count, Map.get(running_entry, :turn_count, 0))
          |> Map.put(:retry_attempt, Map.get(running_entry, :retry_attempt, 0))
          |> Map.put(:last_agent_timestamp, Map.get(running_entry, :last_agent_timestamp))
          |> Map.put(:last_agent_event, Map.get(running_entry, :last_agent_event))
          |> Map.put(:last_agent_message, Map.get(running_entry, :last_agent_message))
        end)

      _ ->
        state
    end
  end

  defp run_state_for_history(running_entry, record) do
    case Map.get(running_entry, :issue) do
      %{state: state} -> state
      _ -> Map.get(record, :state)
    end
  end

  defp update_run_history(%State{} = state, run_id, updater)
       when is_binary(run_id) and is_function(updater, 1) do
    %{
      state
      | run_history:
          Enum.map(state.run_history, fn
            %{id: ^run_id} = run_record -> updater.(run_record)
            run_record -> run_record
          end)
    }
  end

  defp finalize_run_history(%State{} = state, running_entry_or_record, outcome, failure_reason \\ nil) do
    run_id =
      running_entry_or_record
      |> case do
        %{run_id: run_id} when is_binary(run_id) -> run_id
        %{id: run_id} when is_binary(run_id) -> run_id
        _ -> nil
      end

    if is_binary(run_id) do
      ended_at = DateTime.utc_now()

      update_run_history(state, run_id, fn run_record ->
        started_at = Map.get(run_record, :started_at)
        duration_ms = duration_ms(started_at, ended_at)

        run_record
        |> Map.put(:ended_at, ended_at)
        |> Map.put(:duration_ms, duration_ms)
        |> Map.put(:outcome, outcome)
        |> Map.put(:failure_reason, failure_reason)
      end)
    else
      state
    end
  end

  defp snapshot_run_record(run_record, now) when is_map(run_record) do
    ended_at = Map.get(run_record, :ended_at)

    duration_ms =
      Map.get(run_record, :duration_ms) ||
        duration_ms(Map.get(run_record, :started_at), ended_at || now)

    run_record
    |> Map.put(:duration_ms, duration_ms)
    |> Map.put_new(:cost, @empty_cost_summary)
  end

  defp duration_ms(%DateTime{} = started_at, %DateTime{} = ended_at) do
    max(0, DateTime.diff(ended_at, started_at, :millisecond))
  end

  defp duration_ms(_started_at, _ended_at), do: nil

  defp record_session_completion_totals(state, running_entry) when is_map(running_entry) do
    runtime_seconds = running_seconds(running_entry.started_at, DateTime.utc_now())

    usage_totals =
      apply_token_delta(
        state.usage_totals,
        %{
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          seconds_running: runtime_seconds
        }
      )

    %{state | usage_totals: usage_totals}
  end

  defp record_session_completion_totals(state, _running_entry), do: state

  defp refresh_runtime_config(%State{} = state) do
    case Config.settings() do
      {:ok, settings} ->
        apply_runtime_settings(state, settings)

      {:error, reason} ->
        Logger.warning("Skipping runtime config refresh; config load failed: #{inspect(reason)}")
        state
    end
  end

  defp agent_stall_timeout_ms(settings, "claude"), do: settings.claude.stall_timeout_ms
  defp agent_stall_timeout_ms(settings, _kind), do: settings.codex.stall_timeout_ms

  defp retry_candidate_issue?(%Issue{} = issue, active_states, terminal_states, dispatch_settings) do
    candidate_issue?(issue, active_states, terminal_states) and
      issue_matches_dispatch_routes?(issue, dispatch_settings) and
      !unstarted_issue_blocked_by_non_terminal?(issue, terminal_states)
  end

  defp apply_usage_token_delta(
         %{usage_totals: usage_totals} = state,
         %{input_tokens: input, output_tokens: output, total_tokens: total} = token_delta
       )
       when is_integer(input) and is_integer(output) and is_integer(total) do
    updated_totals = apply_token_delta(usage_totals, token_delta)
    %{state | usage_totals: updated_totals}
  end

  defp apply_usage_token_delta(state, _token_delta), do: state

  defp apply_codex_rate_limits(%State{} = state, update) when is_map(update) do
    case extract_rate_limits(update) do
      %{} = rate_limits ->
        %{state | codex_rate_limits: rate_limits}

      _ ->
        state
    end
  end

  defp apply_codex_rate_limits(state, _update), do: state

  defp apply_token_delta(totals, token_delta) do
    totals = if is_map(totals), do: totals, else: @empty_usage_totals
    input_tokens = Map.get(totals, :input_tokens, 0) + token_delta.input_tokens
    output_tokens = Map.get(totals, :output_tokens, 0) + token_delta.output_tokens
    total_tokens = Map.get(totals, :total_tokens, 0) + token_delta.total_tokens

    seconds_running =
      Map.get(totals, :seconds_running, 0) + Map.get(token_delta, :seconds_running, 0)

    %{
      input_tokens: max(0, input_tokens),
      output_tokens: max(0, output_tokens),
      total_tokens: max(0, total_tokens),
      seconds_running: max(0, seconds_running)
    }
  end

  defp extract_token_delta(running_entry, %{event: _, timestamp: _} = update) do
    running_entry = running_entry || %{}
    usage = extract_token_usage(update)

    if per_turn_usage?(running_entry, update) do
      %{
        input_tokens: get_token_usage(usage, :input) || 0,
        output_tokens: get_token_usage(usage, :output) || 0,
        total_tokens: get_token_usage(usage, :total) || 0,
        input_reported: Map.get(running_entry, :usage_last_reported_input_tokens, 0),
        output_reported: Map.get(running_entry, :usage_last_reported_output_tokens, 0),
        total_reported: Map.get(running_entry, :usage_last_reported_total_tokens, 0)
      }
    else
      {
        compute_token_delta(
          running_entry,
          :input,
          usage,
          :usage_last_reported_input_tokens
        ),
        compute_token_delta(
          running_entry,
          :output,
          usage,
          :usage_last_reported_output_tokens
        ),
        compute_token_delta(
          running_entry,
          :total,
          usage,
          :usage_last_reported_total_tokens
        )
      }
      |> Tuple.to_list()
      |> then(fn [input, output, total] ->
        %{
          input_tokens: input.delta,
          output_tokens: output.delta,
          total_tokens: total.delta,
          input_reported: input.reported,
          output_reported: output.reported,
          total_reported: total.reported
        }
      end)
    end
  end

  defp per_turn_usage?(running_entry, update) do
    agent_kind =
      Map.get(update, :agent_kind) ||
        Map.get(running_entry, :agent_kind, "codex")

    agent_kind == "claude"
  end

  defp compute_token_delta(running_entry, token_key, usage, reported_key) do
    next_total = get_token_usage(usage, token_key)
    prev_reported = Map.get(running_entry, reported_key, 0)

    delta =
      if is_integer(next_total) and next_total >= prev_reported do
        next_total - prev_reported
      else
        0
      end

    %{
      delta: max(delta, 0),
      reported: if(is_integer(next_total), do: next_total, else: prev_reported)
    }
  end

  defp extract_token_usage(update) do
    payloads = [
      update[:usage],
      Map.get(update, "usage"),
      Map.get(update, :usage),
      update[:payload],
      Map.get(update, "payload"),
      update
    ]

    Enum.find_value(payloads, &absolute_token_usage_from_payload/1) ||
      Enum.find_value(payloads, &turn_completed_usage_from_payload/1) ||
      %{}
  end

  defp extract_rate_limits(update) do
    rate_limits_from_payload(update[:rate_limits]) ||
      rate_limits_from_payload(Map.get(update, "rate_limits")) ||
      rate_limits_from_payload(Map.get(update, :rate_limits)) ||
      rate_limits_from_payload(update[:payload]) ||
      rate_limits_from_payload(Map.get(update, "payload")) ||
      rate_limits_from_payload(update)
  end

  defp absolute_token_usage_from_payload(payload) when is_map(payload) do
    if integer_token_map?(payload) do
      payload
    else
      absolute_paths = [
        ["params", "msg", "payload", "info", "total_token_usage"],
        [:params, :msg, :payload, :info, :total_token_usage],
        ["params", "msg", "info", "total_token_usage"],
        [:params, :msg, :info, :total_token_usage],
        ["params", "tokenUsage", "total"],
        [:params, :tokenUsage, :total],
        ["tokenUsage", "total"],
        [:tokenUsage, :total]
      ]

      explicit_map_at_paths(payload, absolute_paths)
    end
  end

  defp absolute_token_usage_from_payload(_payload), do: nil

  defp turn_completed_usage_from_payload(payload) when is_map(payload) do
    method = Map.get(payload, "method") || Map.get(payload, :method)

    if method in ["turn/completed", :turn_completed] do
      direct =
        Map.get(payload, "usage") ||
          Map.get(payload, :usage) ||
          map_at_path(payload, ["params", "usage"]) ||
          map_at_path(payload, [:params, :usage])

      if is_map(direct) and integer_token_map?(direct), do: direct
    end
  end

  defp turn_completed_usage_from_payload(_payload), do: nil

  defp rate_limits_from_payload(payload) when is_map(payload) do
    direct = Map.get(payload, "rate_limits") || Map.get(payload, :rate_limits)

    cond do
      rate_limits_map?(direct) ->
        direct

      rate_limits_map?(payload) ->
        payload

      true ->
        rate_limit_payloads(payload)
    end
  end

  defp rate_limits_from_payload(payload) when is_list(payload) do
    rate_limit_payloads(payload)
  end

  defp rate_limits_from_payload(_payload), do: nil

  defp rate_limit_payloads(payload) when is_map(payload) do
    Map.values(payload)
    |> Enum.reduce_while(nil, fn
      value, nil ->
        case rate_limits_from_payload(value) do
          nil -> {:cont, nil}
          rate_limits -> {:halt, rate_limits}
        end

      _value, result ->
        {:halt, result}
    end)
  end

  defp rate_limit_payloads(payload) when is_list(payload) do
    payload
    |> Enum.reduce_while(nil, fn
      value, nil ->
        case rate_limits_from_payload(value) do
          nil -> {:cont, nil}
          rate_limits -> {:halt, rate_limits}
        end

      _value, result ->
        {:halt, result}
    end)
  end

  defp rate_limits_map?(payload) when is_map(payload) do
    limit_id =
      Map.get(payload, "limit_id") ||
        Map.get(payload, :limit_id) ||
        Map.get(payload, "limit_name") ||
        Map.get(payload, :limit_name)

    has_buckets =
      Enum.any?(
        ["primary", :primary, "secondary", :secondary, "credits", :credits],
        &Map.has_key?(payload, &1)
      )

    !is_nil(limit_id) and has_buckets
  end

  defp rate_limits_map?(_payload), do: false

  defp explicit_map_at_paths(payload, paths) when is_map(payload) and is_list(paths) do
    Enum.find_value(paths, fn path ->
      value = map_at_path(payload, path)

      if is_map(value) and integer_token_map?(value), do: value
    end)
  end

  defp explicit_map_at_paths(_payload, _paths), do: nil

  defp map_at_path(payload, path) when is_map(payload) and is_list(path) do
    Enum.reduce_while(path, payload, fn key, acc ->
      if is_map(acc) and Map.has_key?(acc, key) do
        {:cont, Map.get(acc, key)}
      else
        {:halt, nil}
      end
    end)
  end

  defp map_at_path(_payload, _path), do: nil

  defp integer_token_map?(payload) do
    token_fields = [
      :input_tokens,
      :output_tokens,
      :total_tokens,
      :prompt_tokens,
      :completion_tokens,
      :inputTokens,
      :outputTokens,
      :totalTokens,
      :promptTokens,
      :completionTokens,
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "prompt_tokens",
      "completion_tokens",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "promptTokens",
      "completionTokens"
    ]

    token_fields
    |> Enum.any?(fn field ->
      value = payload_get(payload, field)
      !is_nil(integer_like(value))
    end)
  end

  defp get_token_usage(usage, :input),
    do:
      payload_get(usage, [
        "input_tokens",
        "prompt_tokens",
        :input_tokens,
        :prompt_tokens,
        :input,
        "promptTokens",
        :promptTokens,
        "inputTokens",
        :inputTokens
      ])

  defp get_token_usage(usage, :output),
    do:
      payload_get(usage, [
        "output_tokens",
        "completion_tokens",
        :output_tokens,
        :completion_tokens,
        :output,
        :completion,
        "outputTokens",
        :outputTokens,
        "completionTokens",
        :completionTokens
      ])

  defp get_token_usage(usage, :total),
    do:
      payload_get(usage, [
        "total_tokens",
        "total",
        :total_tokens,
        :total,
        "totalTokens",
        :totalTokens
      ])

  defp payload_get(payload, fields) when is_list(fields) do
    Enum.find_value(fields, fn field -> map_integer_value(payload, field) end)
  end

  defp payload_get(payload, field), do: map_integer_value(payload, field)

  defp map_integer_value(payload, field) do
    if is_map(payload) do
      value = Map.get(payload, field)
      integer_like(value)
    else
      nil
    end
  end

  defp running_seconds(%DateTime{} = started_at, %DateTime{} = now) do
    max(0, DateTime.diff(now, started_at, :second))
  end

  defp running_seconds(_started_at, _now), do: 0

  defp integer_like(value) when is_integer(value) and value >= 0, do: value

  defp integer_like(value) when is_binary(value) do
    case Integer.parse(String.trim(value)) do
      {num, _} when num >= 0 -> num
      _ -> nil
    end
  end

  defp integer_like(_value), do: nil
end
