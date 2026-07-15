"""Harness-free tests for inbound steer/interrupt frame parsing and dispatch.

Run with:
    cd integrations/attach-plugin && python3 -m unittest tests.test_inbound_frames -v
"""

import json
import unittest

from cozygateway.attach_client import (
    AttachClient,
    AttachClientConfig,
    InterruptFrame,
    SteerFrame,
    parse_interrupt_frame,
    parse_steer_frame,
)


class ParseSteerFrameTests(unittest.TestCase):
    def test_valid_steer_frame(self):
        frame = parse_steer_frame({"kind": "steer", "threadId": "t", "turnId": "u", "text": "hi"})
        self.assertEqual(frame, SteerFrame(thread_id="t", turn_id="u", text="hi"))

    def test_rejects_wrong_kind_or_missing_fields(self):
        self.assertIsNone(parse_steer_frame({"kind": "turn", "threadId": "t", "turnId": "u", "text": "x"}))
        self.assertIsNone(parse_steer_frame({"kind": "steer", "threadId": "t", "turnId": "u"}))
        self.assertIsNone(parse_steer_frame({"kind": "steer", "threadId": "", "turnId": "u", "text": "x"}))
        self.assertIsNone(parse_steer_frame("nope"))


class ParseInterruptFrameTests(unittest.TestCase):
    def test_valid_interrupt_frame(self):
        frame = parse_interrupt_frame({"kind": "interrupt", "threadId": "t", "turnId": "u"})
        self.assertEqual(frame, InterruptFrame(thread_id="t", turn_id="u"))

    def test_rejects_wrong_kind_or_missing_fields(self):
        self.assertIsNone(parse_interrupt_frame({"kind": "steer", "threadId": "t", "turnId": "u"}))
        self.assertIsNone(parse_interrupt_frame({"kind": "interrupt", "threadId": "t"}))


class DispatchRoutingTests(unittest.TestCase):
    def _client(self):
        self.turns = []
        self.steers = []
        self.interrupts = []
        config = AttachClientConfig(
            gateway_url="http://gw.example",
            token="secret",
            on_turn=self.turns.append,
            on_steer=self.steers.append,
            on_interrupt=self.interrupts.append,
        )
        return AttachClient(config)

    def test_routes_each_kind_to_its_handler(self):
        client = self._client()
        client._dispatch_inbound(json.dumps({"kind": "turn", "threadId": "t", "turnId": "u", "text": "hi"}))
        client._dispatch_inbound(json.dumps({"kind": "steer", "threadId": "t", "turnId": "u", "text": "more"}))
        client._dispatch_inbound(json.dumps({"kind": "interrupt", "threadId": "t", "turnId": "u"}))
        self.assertEqual([t.text for t in self.turns], ["hi"])
        self.assertEqual([s.text for s in self.steers], ["more"])
        self.assertEqual([(i.thread_id, i.turn_id) for i in self.interrupts], [("t", "u")])

    def test_unknown_kind_and_malformed_json_are_dropped(self):
        client = self._client()
        client._dispatch_inbound(json.dumps({"kind": "mystery", "threadId": "t"}))
        client._dispatch_inbound("{not json")
        self.assertEqual(self.turns, [])
        self.assertEqual(self.steers, [])
        self.assertEqual(self.interrupts, [])


if __name__ == "__main__":
    unittest.main()
