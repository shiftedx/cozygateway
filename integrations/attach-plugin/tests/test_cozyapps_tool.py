import unittest

from cozygateway.adapter import register
from cozygateway.attach_client_v1 import HELLO_CAPABILITIES


class _Context:
    def __init__(self): self.tools = []
    def register_platform(self, **_kwargs): pass
    def register_tool(self, **kwargs): self.tools.append(kwargs)


class CozyAppsToolTests(unittest.TestCase):
    def test_registers_the_native_app_upsert_tool_and_capability(self):
        context = _Context()
        register(context)
        tool = next(item for item in context.tools if item["name"] == "cozyapp_upsert")
        self.assertEqual(tool["toolset"], "cozygateway")
        self.assertIn("cozyapps", HELLO_CAPABILITIES)
        description = tool["schema"]["description"]
        for node in ("stack", "section", "text", "image", "list", "keyValue", "button"):
            self.assertIn(node, description)
        self.assertIn("https://", description)
        self.assertIn("destructive", description)


if __name__ == "__main__":
    unittest.main()
