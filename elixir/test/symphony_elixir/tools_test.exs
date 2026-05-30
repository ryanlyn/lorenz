defmodule SymphonyElixir.ToolsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Tools

  describe "execute/3" do
    test "passes read queries through to the configured client" do
      test_pid = self()
      expected_response = %{"data" => %{"issues" => %{"nodes" => []}}}

      result =
        Tools.execute(
          "linear_graphql",
          %{"query" => "query { issues { nodes { id } } }"},
          linear_client: fn query, variables, _opts ->
            send(test_pid, {:linear_called, query, variables})
            {:ok, expected_response}
          end
        )

      assert result == {:ok, %{success: true, payload: expected_response}}
      assert_received {:linear_called, "query { issues { nodes { id } } }", %{}}
    end

    test "marks GraphQL error responses as unsuccessful while preserving the body" do
      expected_response = %{"errors" => [%{"message" => "boom"}], "data" => nil}

      assert {:ok, %{success: false, payload: ^expected_response}} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }"},
                 linear_client: fn _query, _variables, _opts -> {:ok, expected_response} end
               )
    end

    test "propagates client failures as tool payloads" do
      assert {:error, payload} =
               Tools.execute(
                 "linear_graphql",
                 %{"query" => "query { viewer { id } }"},
                 linear_client: fn _query, _variables, _opts -> {:error, :timeout} end
               )

      assert payload["error"]["message"] == "Linear GraphQL tool execution failed."
      assert payload["error"]["reason"] == ":timeout"
    end
  end
end
