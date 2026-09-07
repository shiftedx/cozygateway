"""A Hermes-raised approval can name exactly what it would do (capability 66).

Run with:
    cd integrations/attach-plugin && <hermes venv>/bin/python -m unittest discover -s tests -v

Before this, ``send_approval`` took only ``thread_id, turn_id, approval_id, call_id, name,
status``, so NO Hermes-raised approval, in a room or a 1:1 chat, ever carried a
``BotApprovalScope`` block: the app had nothing to render scoped controls from and the person got
a deny-only card. These pin the two halves that close that gap.

The classifier is the plugin's own responsibility by row 66's own text ("Classifying the action
correctly belongs to the harness that raises it"), so it is conservative on purpose:

* it never copies a command, an argument, a URL or an env value into a wire string, because row 66
  forbids one there and the plugin cannot tell a secret from a path;
* it asks for ``once`` and claims ``unknown`` idempotency, so nothing it emits can be replayed
  automatically; and
* a call it cannot place answers ``None``, which leaves the plain pre-66 card exactly as it is.
"""

import json
import os
import re
import tempfile
import unittest

import cozygateway.adapter as adapter_module
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool

from tests.test_attach_client_v1 import FakeSocket  # noqa: F401  (shared fake, same suite)


NOW_MS = 1_800_000_000_000
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


def _kwargs(**overrides):
    payload = {
        "command": "rm -rf /tmp/build",
        "description": "delete the build directory",
        "pattern_key": "terminal:rm",
        "pattern_keys": ["terminal:rm"],
        "session_key": "sess-1",
        "surface": "gateway",
        "tool_call_id": "call-abc",
    }
    payload.update(overrides)
    return payload


class ApprovalScopeClassifierTests(unittest.TestCase):
    def test_a_destructive_command_is_classified_into_the_closed_block(self):
        scope = adapter_module.classify_approval_scope(_kwargs(), now_ms=NOW_MS)
        self.assertIsNotNone(scope)
        self.assertEqual(scope["kind"], "scoped_approval")
        self.assertEqual(scope["category"], "destructive")
        self.assertEqual(scope["system"], "terminal")
        self.assertEqual(scope["action"], "terminal:rm")
        self.assertEqual(scope["change"], "Run terminal:rm on rm in terminal.")
        self.assertEqual(scope["effects"], [])
        self.assertEqual(scope["reason"], "peer_policy")
        self.assertEqual(scope["retry"], "unknown")
        self.assertEqual(scope["requested"], "once")
        self.assertTrue(SHA256_HEX.match(scope["payloadHash"]))
        self.assertEqual(scope["expiresAt"], NOW_MS + adapter_module.APPROVAL_SCOPE_TTL_MS)
        self.assertEqual(set(scope), {
            "kind", "action", "category", "system", "resource", "change",
            "effects", "reason", "payloadHash", "expiresAt", "retry", "requested",
        })

    def test_every_placeable_category_is_reachable_from_a_real_call(self):
        cases = {
            "money_movement": _kwargs(pattern_key="stripe:create_charge", command="charge 40", description="charge the card"),
            "secret_access": _kwargs(pattern_key="keychain:read_secret", command="read", description="read one stored credential"),
            "destructive": _kwargs(pattern_key="terminal:rm", description="delete a directory"),
            "lock_or_alarm": _kwargs(pattern_key="home:unlock_door", command="unlock", description="unlock the front door"),
            "public_publishing": _kwargs(pattern_key="social:publish_post", command="post", description="publish a post"),
            "account_change": _kwargs(pattern_key="admin:change_account_role", command="promote", description="change an account role"),
        }
        for expected, payload in cases.items():
            with self.subTest(category=expected):
                scope = adapter_module.classify_approval_scope(payload, now_ms=NOW_MS)
                self.assertIsNotNone(scope)
                self.assertEqual(scope["category"], expected)

    def test_an_action_this_plugin_cannot_place_declares_nothing_rather_than_other(self):
        """`other` is the ONE category a standing category grant can cover, so it can never be the
        answer to "I do not know what this is". A plain ask is: it declares no category, the gateway
        refuses a category grant over it (409 approval_category_undeclared), and only the person's
        own single-use grant on the derived binding can ever cover one."""
        for identity in ("terminal:rmdir", "fs:unlink", "terminal:dd", "terminal:chmod",
                         "k8s:drain_node", "github:force_push", "bank:wire",
                         "email:sendgrid_dispatch", "workspace:write_file"):
            with self.subTest(action=identity):
                self.assertIsNone(adapter_module.classify_approval_scope(
                    _kwargs(pattern_key=identity), now_ms=NOW_MS))

    def test_no_emitted_block_ever_declares_other(self):
        for identity in ("stripe:create_charge", "terminal:rm", "home:unlock_door",
                         "social:publish_post", "admin:change_account_role",
                         "keychain:read_secret"):
            scope = adapter_module.classify_approval_scope(_kwargs(pattern_key=identity),
                                                           now_ms=NOW_MS)
            self.assertIsNotNone(scope)
            self.assertNotEqual(scope["category"], "other")

    def test_a_call_it_cannot_place_carries_no_block_at_all(self):
        """Fails closed: no block is the plain pre-66 card, which is correct, not degraded."""
        self.assertIsNone(adapter_module.classify_approval_scope(
            {"surface": "gateway", "tool_call_id": "call-1"}, now_ms=NOW_MS))
        self.assertIsNone(adapter_module.classify_approval_scope(
            _kwargs(pattern_key="", tool_name="", description=""), now_ms=NOW_MS))

    def test_the_change_sentence_is_composed_and_never_the_harness_description(self):
        """Row 66: `change` and `effects` describe an action, they never carry its arguments.

        Hermes descriptions on the answerable surface DO carry them: the write guard builds
        "Write to protected agent-instruction file(s): <absolute paths>." So the sentence is
        composed from the action and the resource this plugin derived, and the harness's own
        description is never copied onto the wire.
        """
        scope = adapter_module.classify_approval_scope(_kwargs(
            pattern_key="fs:delete_protected",
            description=("Write to protected agent-instruction file(s): "
                         "/Users/someone/notes/AGENTS.md, see https://example.invalid/a?token=AKIAsecretvalue"),
        ), now_ms=NOW_MS)
        self.assertIsNotNone(scope)
        for banned in ("AGENTS.md", "https://", "AKIAsecretvalue", "/Users/"):
            self.assertNotIn(banned, json.dumps(scope))
        self.assertEqual(scope["change"],
                         "Run fs:delete_protected on delete_protected in fs.")

    def test_an_action_identity_that_looks_like_an_argument_is_refused_outright(self):
        """The identity is the only thing that reaches a wire string, so it is the only thing that
        has to be checked. Anything carrying a URL, a path, a whitespace run or an assignment is not
        a rule name, and a block built from one could carry a value. No block is the answer."""
        for identity in ("https://example.invalid/x", "terminal:rm /Users/someone/notes",
                         "fs:write token=AKIAsecretvalue", "terminal:rm --key=abc"):
            with self.subTest(action=identity):
                self.assertIsNone(adapter_module.classify_approval_scope(
                    _kwargs(pattern_key=identity), now_ms=NOW_MS))

    def test_no_wire_string_ever_carries_the_command_or_its_arguments(self):
        secret = "AKIAsecretvalue"
        scope = adapter_module.classify_approval_scope(_kwargs(
            pattern_key="s3:publish_object",
            command=f"aws s3 cp ./x s3://bucket --key {secret}",
            description="upload one object",
            arguments={"token": secret, "url": "https://example.invalid/x?token=" + secret},
        ), now_ms=NOW_MS)
        self.assertIsNotNone(scope)
        for field in ("action", "system", "resource", "change"):
            self.assertNotIn(secret, scope[field])
            self.assertNotIn("s3://", scope[field])
            self.assertNotIn("https://", scope[field])
        self.assertNotIn(secret, json.dumps(scope))

    def test_the_hash_moves_with_a_material_change_and_not_with_the_clock(self):
        first = adapter_module.classify_approval_scope(_kwargs(), now_ms=NOW_MS)
        same = adapter_module.classify_approval_scope(_kwargs(), now_ms=NOW_MS + 5_000)
        other = adapter_module.classify_approval_scope(_kwargs(command="rm -rf /tmp/other"), now_ms=NOW_MS)
        self.assertEqual(first["payloadHash"], same["payloadHash"])
        self.assertNotEqual(first["payloadHash"], other["payloadHash"])

    def test_every_string_stays_inside_the_contract_bounds(self):
        scope = adapter_module.classify_approval_scope(_kwargs(
            pattern_key="publish_" + "x" * 400, description="d" * 900), now_ms=NOW_MS)
        self.assertIsNotNone(scope)
        self.assertLessEqual(len(scope["action"]), 64)
        self.assertLessEqual(len(scope["system"]), 64)
        self.assertLessEqual(len(scope["resource"]), 256)
        self.assertLessEqual(len(scope["change"]), 400)


class SendApprovalScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.spool = AttachSpool(os.path.join(self.tmp.name, "spool.sqlite"))
        self.socket = FakeSocket()

        async def connect_factory(url, headers, ssl_ctx):
            return self.socket

        self.client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example", token="secret", spool=self.spool,
            on_turn=lambda _turn: None, connect_factory=connect_factory,
        ))
        await self.client.connect()

    async def asyncTearDown(self):
        await self.client.close()
        self.spool.close()
        self.tmp.cleanup()

    async def _ack(self, version=None):
        ack = {
            "kind": "hello_ack", "capabilities": ["draft", "approvals"],
            "resume": {"eventSequence": 0, "commandSequence": 0},
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
        }
        if version is not None:
            ack["extensions"] = {"com.cozylabs.bots": version}
        await self.client._dispatch_inbound(json.dumps(ack))

    def _event(self):
        return self.spool.pending_events(10, 100_000)[-1]["event"]

    async def test_the_block_rides_the_approval_once_the_gateway_runs_66(self):
        await self._ack(66)
        scope = adapter_module.classify_approval_scope(_kwargs(), now_ms=NOW_MS)
        await self.client.send_approval(
            "thread", "turn", "approval-1", "call-1", "terminal:rm", "pending", scope=scope)
        self.assertEqual(self._event()["scope"], scope)

    async def test_an_approval_below_66_is_byte_identical_to_its_pre_66_self(self):
        await self._ack(65)
        scope = adapter_module.classify_approval_scope(_kwargs(), now_ms=NOW_MS)
        await self.client.send_approval(
            "thread", "turn", "approval-1", "call-1", "terminal:rm", "pending", scope=scope)
        self.assertNotIn("scope", self._event())

    async def test_an_unadvertised_extension_is_read_as_below_66(self):
        await self._ack(None)
        scope = adapter_module.classify_approval_scope(_kwargs(), now_ms=NOW_MS)
        await self.client.send_approval(
            "thread", "turn", "approval-1", "call-1", "terminal:rm", "pending", scope=scope)
        self.assertNotIn("scope", self._event())

    async def test_no_block_is_the_unchanged_call_and_the_unchanged_frame(self):
        await self._ack(66)
        await self.client.send_approval(
            "thread", "turn", "approval-1", "call-1", "terminal:rm", "pending")
        event = self._event()
        self.assertNotIn("scope", event)
        self.assertEqual(event["kind"], "approval")


if __name__ == "__main__":
    unittest.main()
