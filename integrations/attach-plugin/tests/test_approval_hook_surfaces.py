"""An approval card is only drawn for a prompt this platform can answer.

Run with:
    cd integrations/attach-plugin && python3 -m unittest discover -s tests -v

The bug these pin: with ``approvals.mode: smart`` Hermes fires
``pre_approval_request`` for the auxiliary-LLM guardian (``surface="smart"``),
then fires ``post_approval_response`` a second or two later with
``choice="smart_approve"``. Both were forwarded verbatim, so the phone drew an
Approve/Deny card and then tore it down before anybody could read it, let alone
tap it -- and the resolution mapped onto ``cancelled``, which the gateway
reports as ``expired`` ("nobody answered in time") even when the guardian had
approved and the command had run.

``cozygateway.adapter`` imports the harness tree only lazily inside its methods,
so the module-level hook dispatch is exercisable here with no harness on the
path.
"""

import unittest

import cozygateway.adapter as adapter_module


class _RecordingAdapter:
    def __init__(self):
        self.events = []

    def observe_approval_event(self, chat_id, approval_id, name, status):
        self.events.append((chat_id, approval_id, name, status))


def _gateway_kwargs(**overrides):
    payload = {
        "command": "rm -rf /tmp/x",
        "description": "destructive filesystem command",
        "pattern_key": "terminal:rm",
        "pattern_keys": ["terminal:rm"],
        "session_key": "sess-1",
        "surface": "gateway",
        "tool_call_id": "call-abc",
    }
    payload.update(overrides)
    return payload


class ApprovalSurfaceGateTests(unittest.TestCase):
    def setUp(self):
        self._orig_lookup = adapter_module._current_turn_platform_and_chat
        adapter_module._current_turn_platform_and_chat = lambda: (
            adapter_module.PLATFORM_NAME,
            "chat-1",
        )
        self.adapter = _RecordingAdapter()
        adapter_module._register_active_adapter(self.adapter)

    def tearDown(self):
        adapter_module._current_turn_platform_and_chat = self._orig_lookup
        adapter_module._unregister_active_adapter(self.adapter)

    # -- the answerable surfaces still produce a card ---------------------

    def test_gateway_prompt_still_raises_and_settles_a_card(self):
        adapter_module._pre_approval_request(**_gateway_kwargs())
        adapter_module._post_approval_response(**_gateway_kwargs(choice="once"))
        self.assertEqual(
            self.adapter.events,
            [
                ("chat-1", "call-abc", "terminal:rm", "pending"),
                ("chat-1", "call-abc", "terminal:rm", "approved"),
            ],
        )

    def test_mcp_elicitation_is_answerable_too(self):
        kwargs = _gateway_kwargs(surface="mcp-elicitation", pattern_key="mcp_elicitation")
        adapter_module._pre_approval_request(**kwargs)
        self.assertEqual(len(self.adapter.events), 1)
        self.assertEqual(self.adapter.events[0][3], "pending")

    def test_gateway_timeout_is_reported_as_expired(self):
        adapter_module._pre_approval_request(**_gateway_kwargs())
        adapter_module._post_approval_response(**_gateway_kwargs(choice="timeout"))
        self.assertEqual(self.adapter.events[-1][3], "expired")

    def test_gateway_denial_is_reported_as_denied(self):
        adapter_module._pre_approval_request(**_gateway_kwargs())
        adapter_module._post_approval_response(**_gateway_kwargs(choice="deny"))
        self.assertEqual(self.adapter.events[-1][3], "denied")

    # -- the surfaces nobody on this phone decides ------------------------

    def test_smart_guardian_never_draws_a_card(self):
        """The flashing card, in one test."""
        smart = _gateway_kwargs(surface="smart")
        adapter_module._pre_approval_request(**smart)
        adapter_module._post_approval_response(**smart, choice="smart_approve")
        self.assertEqual(self.adapter.events, [])

    def test_smart_deny_never_draws_a_card(self):
        smart = _gateway_kwargs(surface="smart")
        adapter_module._pre_approval_request(**smart)
        adapter_module._post_approval_response(**smart, choice="smart_deny")
        self.assertEqual(self.adapter.events, [])

    def test_cli_prompt_never_draws_a_card(self):
        adapter_module._pre_approval_request(**_gateway_kwargs(surface="cli"))
        self.assertEqual(self.adapter.events, [])

    def test_plugin_transport_never_draws_a_card(self):
        adapter_module._pre_approval_request(**_gateway_kwargs(surface="transport:acme"))
        self.assertEqual(self.adapter.events, [])

    def test_coalesced_follower_never_draws_a_second_card(self):
        follower = _gateway_kwargs(coalesced=True, tool_call_id="call-follower")
        adapter_module._pre_approval_request(**follower)
        adapter_module._post_approval_response(**follower, choice="once")
        self.assertEqual(self.adapter.events, [])

    def test_absent_surface_never_draws_a_card(self):
        payload = _gateway_kwargs()
        payload.pop("surface")
        adapter_module._pre_approval_request(**payload)
        self.assertEqual(self.adapter.events, [])

    # -- the smart guardian must not preempt the escalated human prompt ---

    def test_smart_escalation_to_the_gateway_prompt_still_draws_one_card(self):
        """Guardian says ESCALATE, Hermes then runs the real gateway prompt.

        The guardian's own pre/post pair is dropped; the gateway prompt that
        follows it is the card, and it stays pending until the human answers.
        """
        smart = _gateway_kwargs(surface="smart")
        adapter_module._pre_approval_request(**smart)
        adapter_module._post_approval_response(**smart, choice="smart_escalate")
        adapter_module._pre_approval_request(**_gateway_kwargs())
        self.assertEqual(
            self.adapter.events,
            [("chat-1", "call-abc", "terminal:rm", "pending")],
        )


class AnswerableSurfacePredicateTests(unittest.TestCase):
    def test_surface_is_trimmed_before_it_is_matched(self):
        self.assertTrue(adapter_module._is_answerable_approval({"surface": " gateway "}))

    def test_coalesced_beats_an_answerable_surface(self):
        self.assertFalse(
            adapter_module._is_answerable_approval({"surface": "gateway", "coalesced": True})
        )

    def test_empty_surface_is_not_answerable(self):
        self.assertFalse(adapter_module._is_answerable_approval({"surface": ""}))


if __name__ == "__main__":
    unittest.main()
