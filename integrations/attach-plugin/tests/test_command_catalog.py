import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from cozygateway.adapter import hermes_gateway_commands


class CommandCatalogTests(unittest.TestCase):
    def test_projects_gateway_safe_builtins_plugins_and_skills_without_duplicates(self):
        commands_module = types.ModuleType("hermes_cli.commands")
        commands_module.COMMAND_REGISTRY = [
            SimpleNamespace(name="status", description="Show status", args_hint="", category="Session"),
            SimpleNamespace(name="queue", description="Queue prompt", args_hint="<prompt>", category="Session"),
            SimpleNamespace(name="redraw", description="Redraw terminal", args_hint="", category="Session"),
        ]
        commands_module._resolve_config_gates = lambda: set()
        commands_module._is_gateway_available = lambda command, _overrides: command.name != "redraw"
        commands_module._iter_plugin_command_entries = lambda: [
            ("weather", "Read the weather", "[city]"),
        ]

        skills_module = types.ModuleType("agent.skill_commands")
        skills_module.get_skill_commands = lambda: {
            "/research-paper": {"description": "Research and write a paper"},
            "/status": {"description": "Must not shadow the built-in"},
        }

        modules = {
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.commands": commands_module,
            "agent": types.ModuleType("agent"),
            "agent.skill_commands": skills_module,
        }
        with patch.dict(sys.modules, modules):
            catalog = hermes_gateway_commands()

        self.assertEqual([entry["name"] for entry in catalog], [
            "/status", "/queue", "/weather", "/research-paper",
        ])
        self.assertEqual(catalog[1]["argsHint"], "<prompt>")
        self.assertEqual(catalog[-1]["category"], "Skills")


if __name__ == "__main__":
    unittest.main()
