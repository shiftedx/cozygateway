# CozyGateway

The gateway owns bot identity, conversation continuity, and routing between paired clients and
the computers and harnesses that execute their work.

## Language

**Chat Execution Context**: The computer, workspace, and model selection belonging to one
conversation session. It does not change the bot's other conversations or room work.

**Provider Connection**: A named connection to a model service administered in its owning
harness configuration scope. Bot defaults and conversation overrides can select its models.
