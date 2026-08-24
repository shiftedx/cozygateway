"""The plugin-side gate in front of memory requests: one at a time, applied once.

Run with:
    cd integrations/attach-plugin && python3 -m unittest tests.test_memory_request_gate -v
"""
from __future__ import annotations

import asyncio
import threading
import types
import unittest
from typing import Any, Dict, List, Optional

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client
from cozygateway.memory import MemoryInvalid


class FakeClient(AttachV1Client):
    """Records replies instead of sending them. Subclassed so the adapter's own
    ``isinstance`` guard sees a real client without a socket existing."""

    def __init__(self) -> None:  # noqa: D107 - deliberately skips the real __init__
        self.replies: List[Dict[str, Any]] = []

    async def send_memory_result(self, request_id, status, *, result=None, message=None, current=None):
        reply = {"requestId": request_id, "status": status, "result": result, "message": message, "current": current}
        self.replies.append(reply)
        return reply


def make_adapter() -> AttachAdapter:
    adapter = AttachAdapter()
    adapter._attach_init(types.SimpleNamespace(extra={}))
    adapter._client = FakeClient()
    return adapter


class MemoryRequestGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_second_request_arriving_mid_flight_is_refused_rather_than_queued(self):
        adapter = make_adapter()
        started, release = threading.Event(), threading.Event()

        def slow(operation: str, input: Dict[str, Any]) -> Dict[str, Any]:
            started.set(); release.wait(5)
            return {"items": [], "sources": []}

        adapter._memory_manager.execute = slow  # type: ignore[method-assign]
        first = asyncio.create_task(adapter._handle_memory_command({"requestId": "a", "operation": "items", "input": {}}))
        await asyncio.to_thread(started.wait, 5)
        await adapter._handle_memory_command({"requestId": "b", "operation": "items", "input": {}})
        release.set()
        await first

        replies = {reply["requestId"]: reply for reply in adapter._client.replies}
        self.assertEqual(replies["b"]["status"], "unavailable")
        self.assertIn("busy", replies["b"]["message"])
        self.assertEqual(replies["a"]["status"], "ok")

        # The gate reopens once the in-flight request settles.
        adapter._memory_manager.execute = lambda operation, input: {"items": [], "sources": []}  # type: ignore[method-assign]
        await adapter._handle_memory_command({"requestId": "c", "operation": "items", "input": {}})
        self.assertEqual(adapter._client.replies[-1]["status"], "ok")

    async def test_a_replayed_mutation_returns_the_first_outcome_without_writing_twice(self):
        adapter = make_adapter()
        applied: List[str] = []

        def create(operation: str, input: Dict[str, Any]) -> Dict[str, Any]:
            applied.append(input["content"])
            return {"item": {"id": f"note:{len(applied)}", "sourceId": "vault:0", "kind": "note", "title": "t", "snippet": "s", "timestampKind": "unknown", "revision": "r"}}

        adapter._memory_manager.execute = create  # type: ignore[method-assign]
        command = {"requestId": "same", "operation": "create", "input": {"sourceId": "vault:0", "content": "one note"}}
        await adapter._handle_memory_command(command)
        await adapter._handle_memory_command(dict(command))

        self.assertEqual(applied, ["one note"], "the replayed request must not apply the write again")
        self.assertEqual([reply["result"] for reply in adapter._client.replies], [adapter._client.replies[0]["result"]] * 2)

    async def test_a_replayed_mutation_replays_its_failure_too(self):
        adapter = make_adapter()
        calls: List[str] = []

        def refuse(operation: str, input: Dict[str, Any]) -> Dict[str, Any]:
            calls.append(operation); raise MemoryInvalid("vault note could not be created")

        adapter._memory_manager.execute = refuse  # type: ignore[method-assign]
        command = {"requestId": "same", "operation": "create", "input": {"sourceId": "vault:0", "content": "x"}}
        await adapter._handle_memory_command(command)
        await adapter._handle_memory_command(dict(command))
        self.assertEqual(calls, ["create"])
        self.assertEqual([reply["status"] for reply in adapter._client.replies], ["invalid_request", "invalid_request"])

    async def test_a_replayed_read_is_served_again_rather_than_cached(self):
        adapter = make_adapter()
        calls: List[str] = []
        adapter._memory_manager.execute = lambda operation, input: (calls.append(operation), {"sources": []})[1]  # type: ignore[method-assign]
        for _ in range(2):
            await adapter._handle_memory_command({"requestId": "same", "operation": "overview", "input": {}})
        self.assertEqual(calls, ["overview", "overview"])

    async def test_an_unexpected_fault_is_named_rather_than_reported_as_a_dead_source(self):
        adapter = make_adapter()

        def boom(operation: str, input: Dict[str, Any]) -> Dict[str, Any]:
            raise TypeError("items() missing 1 required positional argument: 'source'")

        adapter._memory_manager.execute = boom  # type: ignore[method-assign]
        await adapter._handle_memory_command({"requestId": "a", "operation": "items", "input": {}})
        reply = adapter._client.replies[-1]
        self.assertEqual(reply["status"], "unavailable")
        self.assertIn("TypeError", reply["message"])

    async def test_the_receive_loop_hands_the_request_off_instead_of_serving_it(self):
        adapter = make_adapter()
        release = asyncio.Event()

        def slow(operation: str, input: Dict[str, Any]) -> Dict[str, Any]:
            return {"sources": []}

        adapter._memory_manager.execute = slow  # type: ignore[method-assign]
        adapter._on_memory_command({"requestId": "a", "operation": "overview", "input": {}})
        # The callback the client awaits inline has already returned, before the
        # request it spawned has run at all.
        self.assertEqual(adapter._client.replies, [])
        self.assertEqual(len(adapter._background_tasks), 1)
        await asyncio.gather(*list(adapter._background_tasks))
        self.assertEqual(adapter._client.replies[-1]["status"], "ok")

    async def test_the_completed_mutation_cache_stays_bounded(self):
        adapter = make_adapter()
        adapter._memory_manager.execute = lambda operation, input: {"id": "note:1", "revision": "r"}  # type: ignore[method-assign]
        for index in range(adapter._memory_results_max + 10):
            await adapter._handle_memory_command({"requestId": f"r{index}", "operation": "delete", "input": {"sourceId": "vault:0", "itemId": "note:1", "expectedRevision": "r"}})
        self.assertEqual(len(adapter._memory_results), adapter._memory_results_max)


if __name__ == "__main__":
    unittest.main()
