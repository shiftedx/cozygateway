# CozyGateway

The gateway owns Hermes profile identity, conversation continuity, and routing between paired
CozyChat clients and Hermes Agent. Its attach-v1 boundary remains generic so compatible harness
adapters can use the published contract; CozyAgents ships its own embedded gateway.

## Language

**Chat Execution Context**: The computer, workspace, and model selection belonging to one
conversation session. It does not change the bot's other conversations or room work.

**Provider Connection**: A named connection to a model service administered in its owning
harness configuration scope. Bot defaults and conversation overrides can select its models.
