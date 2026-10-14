"""Unit tests for the delegation lifecycle hook dispatch behind live batch cards.

Run with:
    cd integrations/attach-plugin && python3 -m unittest discover -s tests -v

Same harness-free pattern as ``test_tool_hook_dispatch_call_id.py``: the session
context lookup is monkeypatched and a recording fake stands in for the adapter,
so these tests observe exactly what ``_dispatch_delegation_hook`` forwards --
batch identity, spawn-order indices, the closed status vocabulary, and the
bounded display fields (a truncated goal label, a tool count; nothing else).
"""

import json
import unittest

import cozygateway.adapter as adapter_module


class _RecordingAdapter:
    def __init__(self):
        self.events = []

    def observe_delegation_event(self, chat_id, payload):
        self.events.append((chat_id, payload))


def _reset_registry():
    with adapter_module._DELEGATION_BATCHES_LOCK:
        adapter_module._DELEGATION_BATCHES.clear()
        adapter_module._DELEGATION_PARENT_LATEST.clear()
        adapter_module._DELEGATION_PENDING_ALIASES.clear()


class DelegationHookDispatchTests(unittest.TestCase):
    def setUp(self):
        self._orig_lookup = adapter_module._current_turn_platform_and_chat
        adapter_module._current_turn_platform_and_chat = lambda: (
            adapter_module.PLATFORM_NAME,
            "chat-1",
        )
        self.adapter = _RecordingAdapter()
        adapter_module._register_active_adapter(self.adapter)
        adapter_module._CURRENT_DELEGATION_CALL.set("call-7")
        _reset_registry()

    def tearDown(self):
        adapter_module._current_turn_platform_and_chat = self._orig_lookup
        adapter_module._unregister_active_adapter(self.adapter)
        adapter_module._CURRENT_DELEGATION_CALL.set(None)
        _reset_registry()

    def test_start_leg_forwards_batch_identity_and_running_status(self):
        adapter_module._subagent_start(
            parent_session_id="parent",
            child_session_id="child-1",
            child_role="leaf",
            child_goal="Summarize the report",
        )
        self.assertEqual(len(self.adapter.events), 1)
        chat_id, payload = self.adapter.events[0]
        self.assertEqual(chat_id, "chat-1")
        self.assertEqual(payload["batch_id"], "call-7")
        self.assertEqual(payload["child_id"], "child-1")
        self.assertEqual(payload["index"], 0)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["status"], "running")
        self.assertEqual(payload["label"], "Summarize the report")
        self.assertGreater(payload["last_active_at"], 0)

    def test_siblings_get_spawn_order_indices_and_growing_count(self):
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="a"
        )
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-2", child_goal="b"
        )
        (_, first), (_, second) = self.adapter.events
        self.assertEqual((first["index"], first["count"]), (0, 1))
        self.assertEqual((second["index"], second["count"]), (1, 2))
        self.assertEqual(first["batch_id"], second["batch_id"])

    def test_context_free_finish_leg_routes_via_retained_parent_association(self):
        # The spawn leg runs with full session context (the copied parent tool context)...
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="g"
        )
        # ...but an async batch's consolidation thread may carry none at all.
        adapter_module._current_turn_platform_and_chat = lambda: (None, None)
        adapter_module._CURRENT_DELEGATION_CALL.set(None)
        adapter_module._subagent_stop(
            parent_session_id="parent",
            child_session_id="child-1",
            child_status="completed",
            tool_call_history=[{"tool_name": "write_file"}, {"tool_name": "search"}],
        )
        chat_id, payload = self.adapter.events[-1]
        self.assertEqual(chat_id, "chat-1")
        self.assertEqual(payload["batch_id"], "call-7")
        self.assertEqual(payload["child_id"], "child-1")
        self.assertEqual(payload["index"], 0)
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(payload["tool_count"], 2)

    def test_terminal_status_mapping_is_closed_and_honest(self):
        for raw, wire in (
            ("completed", "succeeded"),
            ("failed", "failed"),
            ("error", "failed"),
            ("interrupted", "interrupted"),
            ("cancelled", "interrupted"),
            # An unprovable outcome is `unknown`, never `failed`.
            ("exploded", "unknown"),
            (None, "unknown"),
        ):
            self.adapter.events.clear()
            adapter_module._subagent_stop(
                parent_session_id="parent",
                child_session_id="child-1",
                child_status=raw,
                tool_call_history=[],
            )
            self.assertEqual(self.adapter.events[0][1]["status"], wire, raw)

    def test_forbidden_fields_never_leave_the_dispatch(self):
        adapter_module._subagent_start(
            parent_session_id="parent",
            child_session_id="child-1",
            child_goal="g",
            child_role="leaf",
        )
        adapter_module._subagent_stop(
            parent_session_id="parent",
            child_session_id="child-1",
            child_status="completed",
            child_summary="a whole child transcript summary",
            tool_call_history=[{"tool_name": "write_file", "args": {"path": "/secret"}}],
            duration_ms=1234,
        )
        allowed = {
            "batch_id", "child_id", "index", "count", "status",
            "label", "tool_count", "last_active_at",
        }
        for _chat, payload in self.adapter.events:
            self.assertLessEqual(set(payload), allowed, payload)

    def test_goal_label_is_truncated_to_wire_bound(self):
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="x" * 500
        )
        self.assertEqual(len(self.adapter.events[0][1]["label"]), 200)

    def test_missing_child_session_id_drops_the_event(self):
        adapter_module._subagent_start(child_session_id=None, child_goal="g")
        adapter_module._subagent_stop(child_session_id="  ", child_status="completed")
        self.assertEqual(self.adapter.events, [])

    def test_other_platform_turns_are_ignored(self):
        adapter_module._current_turn_platform_and_chat = lambda: ("cli", "chat-1")
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="g"
        )
        self.assertEqual(self.adapter.events, [])

    def test_unassociated_context_free_leg_is_not_routable(self):
        adapter_module._current_turn_platform_and_chat = lambda: (None, None)
        adapter_module._CURRENT_DELEGATION_CALL.set(None)
        adapter_module._subagent_stop(
            parent_session_id="stranger", child_session_id="child-1", child_status="completed"
        )
        self.assertEqual(self.adapter.events, [])

    def test_pre_and_post_tool_call_manage_the_batch_call_id(self):
        adapter_module._CURRENT_DELEGATION_CALL.set(None)
        adapter_module._pre_tool_call(tool_name="delegate_task", tool_call_id="call-9")
        self.assertEqual(adapter_module._CURRENT_DELEGATION_CALL.get(), "call-9")
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="g"
        )
        self.assertEqual(self.adapter.events[0][1]["batch_id"], "call-9")
        adapter_module._post_tool_call(tool_name="delegate_task", tool_call_id="call-9")
        self.assertIsNone(adapter_module._CURRENT_DELEGATION_CALL.get())

    def test_overlapping_batches_keep_identity_by_call_id(self):
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="a"
        )
        adapter_module._CURRENT_DELEGATION_CALL.set("call-8")
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-9", child_goal="b"
        )
        # The first batch's finish leg still lands on ITS batch, not the newest one.
        adapter_module._CURRENT_DELEGATION_CALL.set("call-7")
        adapter_module._subagent_stop(
            parent_session_id="parent", child_session_id="child-1",
            child_status="completed", tool_call_history=[],
        )
        stop_payload = self.adapter.events[-1][1]
        self.assertEqual(stop_payload["batch_id"], "call-7")
        self.assertEqual(stop_payload["index"], 0)
        self.assertEqual(self.adapter.events[1][1]["batch_id"], "call-8")


class DelegationAliasCaptureTests(unittest.TestCase):
    """``post_tool_call`` captures Hermes's canonical delegation id from the
    STRUCTURED ``delegate_task`` result (a JSON object string carrying a
    top-level ``delegation_id``; the ``live_transcripts`` path segment is the
    explicit documented fallback) and rides it on subsequent frames as
    ``alias_id``. An older result shape yields no alias and changes nothing
    else."""

    DISPATCHED = {
        "status": "dispatched",
        "mode": "background",
        "count": 1,
        "delegation_id": "deleg_c6eb9310",
        "goals": ["g"],
        "note": "Subagent is running in the background.",
    }

    def setUp(self):
        self._orig_lookup = adapter_module._current_turn_platform_and_chat
        adapter_module._current_turn_platform_and_chat = lambda: (
            adapter_module.PLATFORM_NAME,
            "chat-1",
        )
        self.adapter = _RecordingAdapter()
        adapter_module._register_active_adapter(self.adapter)
        adapter_module._CURRENT_DELEGATION_CALL.set("call-7")
        _reset_registry()

    def tearDown(self):
        adapter_module._current_turn_platform_and_chat = self._orig_lookup
        adapter_module._unregister_active_adapter(self.adapter)
        adapter_module._CURRENT_DELEGATION_CALL.set(None)
        _reset_registry()

    def _finish(self, result):
        """The async shape: spawn leg inside the call, then the tool result."""
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="g"
        )
        adapter_module._post_tool_call(
            tool_name="delegate_task", tool_call_id="call-7", result=result
        )
        adapter_module._subagent_stop(
            parent_session_id="parent",
            child_session_id="child-1",
            child_status="completed",
            tool_call_history=[],
        )

    def test_structured_delegation_id_rides_subsequent_frames(self):
        self._finish(json.dumps(self.DISPATCHED))
        start_payload = self.adapter.events[0][1]
        stop_payload = self.adapter.events[-1][1]
        # The spawn leg ran before the result existed: no alias yet.
        self.assertNotIn("alias_id", start_payload)
        self.assertEqual(stop_payload["alias_id"], "deleg_c6eb9310")
        self.assertEqual(stop_payload["batch_id"], "call-7")
        self.assertEqual(stop_payload["status"], "succeeded")

    def test_live_transcript_path_is_the_explicit_documented_fallback(self):
        payload = dict(self.DISPATCHED)
        del payload["delegation_id"]
        payload["live_transcripts"] = [
            "/Users/u/.hermes/profiles/cleo/cache/delegation/live/deleg_ab12cd34/task-0.log"
        ]
        self._finish(json.dumps(payload))
        self.assertEqual(self.adapter.events[-1][1]["alias_id"], "deleg_ab12cd34")

    def test_older_result_shapes_yield_no_alias_and_change_nothing_else(self):
        for result in (
            json.dumps({"status": "success", "results": ["done"]}),  # sync aggregate
            "All 1 subagent(s) completed.",  # prose, never parsed
            "{not json",  # malformed
            None,
        ):
            self.adapter.events.clear()
            _reset_registry()
            adapter_module._CURRENT_DELEGATION_CALL.set("call-7")
            self._finish(result)
            stop_payload = self.adapter.events[-1][1]
            self.assertNotIn("alias_id", stop_payload, result)
            self.assertEqual(stop_payload["status"], "succeeded", result)
            self.assertEqual(stop_payload["batch_id"], "call-7", result)

    def test_malformed_delegation_id_shapes_are_refused(self):
        for alias in ("", "deleg_", "sa-0-d94c0393", "../etc/passwd", 7):
            self.adapter.events.clear()
            _reset_registry()
            adapter_module._CURRENT_DELEGATION_CALL.set("call-7")
            self._finish(json.dumps({**self.DISPATCHED, "delegation_id": alias}))
            self.assertNotIn("alias_id", self.adapter.events[-1][1], alias)

    def test_alias_parked_before_the_batch_exists_is_adopted_at_creation(self):
        # Defensive ordering: the result lands before any lifecycle leg made the batch.
        adapter_module._post_tool_call(
            tool_name="delegate_task",
            tool_call_id="call-7",
            result=json.dumps(self.DISPATCHED),
        )
        adapter_module._CURRENT_DELEGATION_CALL.set("call-7")
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="g"
        )
        self.assertEqual(self.adapter.events[0][1]["alias_id"], "deleg_c6eb9310")

    def test_alias_widens_the_bounded_payload_by_exactly_one_field(self):
        self._finish(json.dumps(self.DISPATCHED))
        allowed = {
            "batch_id", "child_id", "index", "count", "status",
            "label", "tool_count", "last_active_at", "alias_id",
        }
        for _chat, payload in self.adapter.events:
            self.assertLessEqual(set(payload), allowed, payload)


class DelegationStructuredResultTests(unittest.TestCase):
    def setUp(self):
        self._orig_lookup = adapter_module._current_turn_platform_and_chat
        adapter_module._current_turn_platform_and_chat = lambda: (
            adapter_module.PLATFORM_NAME,
            "chat-1",
        )
        self.adapter = _RecordingAdapter()
        adapter_module._register_active_adapter(self.adapter)
        adapter_module._CURRENT_DELEGATION_CALL.set("call-sync")
        _reset_registry()
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-0", child_goal="zero"
        )
        adapter_module._subagent_start(
            parent_session_id="parent", child_session_id="child-1", child_goal="one"
        )
        self.adapter.events.clear()

    def tearDown(self):
        adapter_module._current_turn_platform_and_chat = self._orig_lookup
        adapter_module._unregister_active_adapter(self.adapter)
        adapter_module._CURRENT_DELEGATION_CALL.set(None)
        _reset_registry()

    def _post(self, result):
        adapter_module._post_tool_call(
            tool_name="delegate_task", tool_call_id="call-sync", result=result
        )

    def test_reordered_rows_join_children_by_explicit_task_index(self):
        self._post(json.dumps({"results": [
            {
                "task_index": 1, "status": "completed", "cost_usd": 0.25,
                "cost_status": "reported", "schema_valid": False, "schema_retries": 1,
                "schema_errors": ["private validator detail"], "duration_seconds": 2.345,
                "summary": "private summary", "tokens": {"input": 99},
                "tool_trace": [{"args": {"path": "/private"}}],
            },
            {
                "task_index": 0, "status": "completed", "cost_usd": 0.1,
                "cost_status": "estimated", "schema_valid": True,
                "duration_seconds": 1,
            },
        ]}))
        payloads = [payload for _chat, payload in self.adapter.events]
        self.assertEqual([payload["child_id"] for payload in payloads], ["child-1", "child-0"])
        self.assertEqual([payload["index"] for payload in payloads], [1, 0])
        self.assertEqual(payloads[0]["cost_usd"], 0.25)
        self.assertEqual(payloads[0]["cost_status"], "reported")
        self.assertEqual(payloads[0]["schema_validation"], {"valid": False, "retries": 1})
        self.assertEqual(payloads[0]["duration_ms"], 2345)
        forbidden = {"schema_errors", "summary", "tokens", "tool_trace", "args", "result"}
        self.assertTrue(all(forbidden.isdisjoint(payload) for payload in payloads))

    def test_unavailable_schema_is_distinct_from_false_and_bad_values_are_absent(self):
        self._post({"results": [
            {"task_index": 0, "status": "completed", "cost_usd": float("inf"),
             "schema_valid": "false", "duration_seconds": -1},
            {"task_index": 1, "status": "failed", "cost_usd": 4,
             "cost_status": "future-label", "schema_valid": False, "schema_retries": 9},
        ]})
        first, second = [payload for _chat, payload in self.adapter.events]
        for field in ("cost_usd", "cost_status", "schema_validation", "duration_ms"):
            self.assertNotIn(field, first)
        self.assertEqual(second["cost_status"], "unknown")
        self.assertEqual(second["schema_validation"], {"valid": False})

    def test_overflow_values_are_omitted_without_dropping_valid_sibling_rows(self):
        self._post({"results": [
            {"task_index": 0, "status": "completed", "cost_usd": 10**400,
             "duration_seconds": 10**400, "schema_valid": True},
            {"task_index": 1, "status": "completed", "cost_usd": 0.5,
             "cost_status": "reported", "duration_seconds": 1.25},
        ]})
        first, second = [payload for _chat, payload in self.adapter.events]
        self.assertNotIn("cost_usd", first)
        self.assertNotIn("duration_ms", first)
        self.assertEqual(first["schema_validation"], {"valid": True})
        self.assertEqual(second["cost_usd"], 0.5)
        self.assertEqual(second["duration_ms"], 1250)

    def test_background_older_and_malformed_results_emit_no_enrichment(self):
        for result in (
            json.dumps({"status": "dispatched", "mode": "background", "delegation_id": "deleg_12345678"}),
            json.dumps({"results": ["old prose row"]}),
            json.dumps({"results": [{"task_index": 99, "status": "completed", "cost_usd": 1}]}),
            "{not json",
            None,
        ):
            self.adapter.events.clear()
            self._post(result)
            self.assertEqual(self.adapter.events, [], result)
