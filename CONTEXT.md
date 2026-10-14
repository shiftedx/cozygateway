# CozyGateway

The gateway owns Hermes profile identity, conversation continuity, and routing between paired
CozyChat clients and Hermes Agent. Its attach-v1 boundary remains generic so an OpenClaw adapter
can use the published contract; CozyAgents ships its own bundled gateway.

## Language

**CozyGateway**: The gateway that connects Hermes (and, soon, OpenClaw) bots to CozyChat. It hosts
no CozyAgents bots; those use CozyAgents' own bundled gateway (ADR 0086).

**Chat Execution Context**: The computer, workspace, and model selection belonging to one
conversation session. It does not change the bot's other conversations or room work.

**Provider Connection**: A named connection to a model service administered in its owning
harness configuration scope. Bot defaults and conversation overrides can select its models.
