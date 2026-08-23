"""Pinned-Hermes subprocess harness for the live Mobile Node tool seam.

It intentionally does one thing: receive the gateway-issued native turn, bind
that exact turn to the real registered tool context, and dispatch the real
Hermes tool through a real ``AttachV1Client``.  JSON lines are a tiny test
control surface for the Node E2E test, not a protocol or a second harness.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

import cozygateway.adapter as adapter_module
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool


def emit(kind: str, **fields: object) -> None:
    print(json.dumps({"e2e": kind, **fields}, separators=(",", ":")), flush=True)


def main() -> int:
    root = Path(os.environ["HERMES_AGENT_ROOT"])
    sys.path.insert(0, str(root))
    from gateway.session_context import clear_session_vars, set_session_vars
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    import model_tools

    gateway_url = os.environ["COZYGATEWAY_URL"]
    token = os.environ["COZYGATEWAY_TOKEN"]
    profile = os.environ.get("HERMES_PROFILE", "sage")
    turns: queue.Queue[object] = queue.Queue()
    loop = asyncio.new_event_loop()
    loop_ready = threading.Event()
    adapter = adapter_module.AttachAdapter()
    spool_dir: str | None = None
    client: AttachV1Client | None = None
    spool: AttachSpool | None = None
    watch: asyncio.Task[None] | None = None

    def run_loop() -> None:
        asyncio.set_event_loop(loop)
        loop_ready.set()
        loop.run_forever()
        loop.close()

    thread = threading.Thread(target=run_loop, daemon=True)
    thread.start()
    if not loop_ready.wait(2):
        emit("error", message="attach loop did not start")
        return 1

    def on_turn(turn: object) -> None:
        # The gateway-generated command is the sole source of these values.
        thread_id = getattr(turn, "thread_id", None)
        turn_id = getattr(turn, "turn_id", None)
        if isinstance(thread_id, str) and isinstance(turn_id, str):
            adapter._active_turn[thread_id] = turn_id
            turns.put(turn)

    async def connect() -> tuple[AttachV1Client, AttachSpool, asyncio.Task[None]]:
        nonlocal client, spool, spool_dir
        spool_dir = tempfile.mkdtemp(prefix="cozy-mobile-e2e-")
        spool = AttachSpool(os.path.join(spool_dir, "attach.sqlite"))
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=gateway_url, token=token, spool=spool, on_turn=on_turn,
        ))
        await client.connect()
        watch = asyncio.create_task(client.watch())
        deadline = time.monotonic() + 5
        while not client._negotiated:
            if time.monotonic() >= deadline:
                raise TimeoutError("attach hello was not negotiated")
            await asyncio.sleep(0.01)
        return client, spool, watch

    try:
        client, spool, watch = asyncio.run_coroutine_threadsafe(connect(), loop).result(10)
        adapter._client = client
        adapter._loop = loop
        adapter._active_turn = {}
        adapter._profile = profile
        adapter_module._register_active_adapter(adapter)
        adapter_module.register(PluginContext(PluginManifest(name="cozygateway"), PluginManager()))
        emit("ready")

        turn = turns.get(timeout=10)
        thread_id = getattr(turn, "thread_id")
        turn_id = getattr(turn, "turn_id")
        tokens = set_session_vars(
            platform=adapter_module.PLATFORM_NAME,
            chat_id=thread_id,
            message_id=turn_id,
            profile=profile,
            cron_session="",
        )
        try:
            result = model_tools.handle_function_call(
                "cozy_device_status", {}, enabled_tools=["cozy_device_status"],
            )
        finally:
            clear_session_vars(tokens)
        emit("result", threadId=thread_id, turnId=turn_id, result=json.loads(result))
        return 0
    except Exception as error:  # pragma: no cover - surfaced as the Node test failure
        emit("error", message=f"{type(error).__name__}: {error}")
        return 1
    finally:
        adapter_module._unregister_active_adapter(adapter)
        if client is not None or spool is not None:
            async def close() -> None:
                if client is not None:
                    await client.close()
                if watch is not None:
                    watch.cancel()
                    await asyncio.gather(watch, return_exceptions=True)
                if spool is not None:
                    spool.close()
            asyncio.run_coroutine_threadsafe(close(), loop).result(5)
        loop.call_soon_threadsafe(loop.stop)
        thread.join(2)
        tool_loop = getattr(model_tools, "_tool_loop", None) if "model_tools" in locals() else None
        if tool_loop is not None and not tool_loop.is_closed():
            tool_loop.close()
        if spool_dir is not None:
            shutil.rmtree(spool_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
