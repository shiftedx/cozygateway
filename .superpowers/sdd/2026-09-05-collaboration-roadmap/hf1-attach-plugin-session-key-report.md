# HF1: attach plugin drops every turn on a strictly bound thread

Branch `codex/hf1-attach-plugin-session-key` from `origin/main` f3d70ef. Plugin only; Hermes core,
the installed plugin copy and the live profiles were read only.

## Diagnosis, confirmed

Read against the pinned Hermes core checkout (a6e10e69) and the plugin source in this worktree.

1. `integrations/attach-plugin/cozygateway/adapter.py` `_inbound_source` stamped
   `source.profile = self._profile` whenever the adapter held a loader owned profile. In a normal
   per profile install that profile comes from `HERMES_HOME`, so it is always set.
2. Core `gateway/platforms/base.py:2317` `_event_session_key` builds the adapter level key with
   `profile=self._session_key_profile(source)`, and `_session_key_profile` (line 2293) reads
   `source.profile` first. With the stamp present the adapter derives
   `agent:<profile>:cozygateway:dm:<thread>`.
3. Core `gateway/run.py:3770` `_session_key_for_source` calls
   `SessionStore._generate_session_key`, whose `_resolve_profile_for_key` only namespaces when
   `multiplex_profiles` is on. Kyle's bots are single profile processes, so the runner key stays
   `agent:main:cozygateway:dm:<thread>`, which is the form in the session store, `sessions.json`
   and the runner logs.
4. The plugin records the desktop binding with the runner form
   (`_desktop_session_bindings[thread_id] = (runner._session_key_for_source(source), target)`) and
   attaches it in `_handle_turn` as `gateway_session_key` plus `gateway_session_strict`.
5. `base.py:3473` compares `_event_session_key(event)` with that metadata and returns before
   dispatch on a mismatch ("Dropping internally routed event: expected session=... derived=..."),
   while `gateway/run_turn.py` (`_hmwa_resolve_session`) compares the same metadata with
   `_session_key_for_source` and additionally looks the key up in the session store. The two checks
   therefore demand different values, and only the strict path is reached, which is why the bots
   without a resumed desktop binding kept working.

Only an unstamped source satisfies both checks at once: the store itself is keyed `agent:main:...`,
so making the binding profile namespaced would have failed the runner check and the strict
`lookup_by_session_key`. That settles the choice.

## The choice

Stop stamping `source.profile` in `_inbound_source`. `build_source` in core already stamps a real
`gateway.profile_routes` match, and that route is left untouched, so a genuine multiplex route
still reaches Hermes; only the plugin's own single profile stamp is gone. Adapter key, runner key
and the recorded binding now all resolve `agent:main:cozygateway:dm:<thread>`.

The stamp existed for one reader. `HERMES_SESSION_PROFILE` is set by core from
`context.source.profile` (`gateway/run.py:4104`), and `_resolve_live_origin` required it to be non
empty and equal to `adapter._profile`, else `profile_mismatch` (the 2026-08-26 regression recorded
in `_profile_from_hermes_home`). Every other reader of that variable in core
(`tools/terminal_tool.py`, `tools/kanban_tools.py`) already tolerates an empty value, exactly as it
is for every other platform in a single profile install.

So the gate was moved onto the same footing instead of onto the stamp: a new
`AttachAdapter._session_profile_route()` returns the route this adapter's own turns actually carry,
and `_resolve_live_origin` demands exact equality with it.

- single profile gateway (`multiplex_profiles` off): expects `""`, matches the now unstamped turn.
- multiplexed gateway: expects the adapter's own profile, which is what `build_source` stamps.
- no runner to describe the topology (isolated unit contexts): keeps demanding the adapter's own
  profile, so the gate is never relaxed on a process the plugin cannot see.

A foreign or absent route still fails, so the check stays exact and fail closed; the existing
`profile_mismatch` cases in `tests/test_mobile_node_tool.py` (a foreign profile, and a `None`
profile against an adapter that reports its own) are unchanged and still pass. `_resolve_live_origin`
now returns the origin adapter's `_profile` identity as its fourth element, so the post await lease
checks in `_cozy_mobile` and `cozy_send_media` compare adapter identity to adapter identity rather
than to a session value that is empty by design.

## Addendum: no refusal ends in silence

The lead's addendum covers the second half of the loss. A turn the plugin declines to dispatch
was silently dropped, so the gateway kept it running to its cap; the next message arrived as a
steer on that turn; the restarted plugin held no such turn and answered it as a fresh inbound,
whose draft and commit events on `<turn>:steer` the gateway declined as orphaned.

1. A turn frame carrying a strict binding this process can no longer derive is refused with a
   typed `failed` terminal and cleaned up, instead of being injected into a check that returns
   silently. `_binding_still_derives` re-derives the recorded key through
   `runner._session_key_for_source` and compares it with the binding; with no runner, or if the
   derivation raises, the turn proceeds as before rather than being refused on an absence.
2. A steer or an interrupt for a turn id the plugin does not hold is answered with a typed
   unknown-turn `failed` on that turn id (`_holds_turn`) and is not injected. One exemption, on
   the interrupt only: a turn this process ran and already sealed (still in `_seen_turns`) lost a
   harmless race, carries no text to preserve, and a failed terminal on it would contradict the
   reply it already delivered, so that case stays quiet. A steer is never exempt: its text is the
   thing at risk, and HF2 promotes the refused steer to a new durable turn.

Missing reason, as asked: the attach `failed` frame has no typed refusal reason. Its wire shape
is `{kind, threadId, turnId, messageId, message}` with a free-text `message` capped at 4096
(`attach_client_v1.send_failed`), and the gateway surfaces it as `error/turn_failed` with that
text (`packages/gateway/src/turns.ts`). There is no `unknown_turn` or `session_binding_stale`
member anywhere in `packages/contract/src`, so the plugin uses two fixed module-level constants,
`UNKNOWN_TURN_FAILURE` and `STALE_SESSION_BINDING_FAILURE`, which a reader can match exactly. A
typed `reason` on the failed frame is worth adding with HF2's turn promotion.

Deliberately left alone: `_on_turn`'s refusal of a frame for another conversation
(`_execution_thread_allowed`) stays silent. That frame belongs to a different execution process,
and terminalizing another process's turn would be worse than not answering. The bounded duplicate
`_seen_turns` drop also stays silent, since the original delivery of that turn is what settles it.

## RED then GREEN

Suite runner: plain `unittest`, no pytest. `python3` on this box has no `websockets`, so the
harness dependent files only load under the Hermes venv interpreter
(`<hermes home>/hermes-agent/venv/bin/python`, Python 3.11.15, read only use).

RED, before the fix, with the new test file:

    python3 -m unittest tests.test_session_key_binding -v
    Ran 9 tests - FAILED (failures=3, errors=3)

The failure text is the live one:

    ('agent:main:cozygateway:dm:native:sage:1',
     'agent:polished-satellite:cozygateway:dm:native:sage:1')

GREEN, after the fix:

    python3 -m unittest tests.test_session_key_binding -v
    Ran 9 tests - OK

RED for the addendum, with the same fakes plus a client that records terminal frames:

    <hermes venv>/bin/python -m unittest tests.test_session_key_binding
    Ran 14 tests - FAILED (failures=3)

the three being the refused turn, the unheld steer and the unheld interrupt; the two tests that
pin the unchanged running-turn behavior passed throughout. GREEN after the terminal frames, with
two more tests for the sealed-turn cases:

    <hermes venv>/bin/python -m unittest tests.test_session_key_binding
    Ran 16 tests - OK

Full plugin suite under the Hermes venv interpreter, after both fixes:

    <hermes venv>/bin/python -m unittest discover -s tests
    Ran 542 tests in 27.4s - OK (skipped=1)

Baseline for comparison: the same command on f3d70ef ran 526 tests with no failures (an archived
copy of `integrations/attach-plugin` alone reports 2 errors for two tests that read files from
elsewhere in the repo; both pass in the worktree). The 16 added tests are the new file.

No behavior change for a turn without a binding: `test_a_turn_without_a_binding_carries_no_session_metadata`
pins that such a turn still carries empty metadata and is delivered, and the strict path is entered
only when `_desktop_session_bindings` holds the thread.

## Files

- `integrations/attach-plugin/cozygateway/adapter.py` - `_inbound_source` no longer stamps the
  profile, new `_session_profile_route`, `_resolve_live_origin` gate and returned identity,
  the two post await lease comparisons, and the `_profile_from_hermes_home` docstring; plus the
  two failure constants, `_binding_still_derives` and the `_handle_turn` refusal, and
  `_holds_turn` with its `_handle_steer` and `_handle_interrupt` guards.
- `integrations/attach-plugin/tests/test_session_key_binding.py` - new, 16 tests.
- `integrations/attach-plugin/tests/test_desktop_session_resume.py` - the fake runner now models
  the real profile agnostic derivation (and asserts the source carries no profile); expected keys
  move to the `agent:main` form.
- `integrations/attach-plugin/tests/test_inbound_frames.py` - the injected source no longer carries
  a profile; the steer and interrupt cases now name the turn the adapter holds.

## Commits

- `ae992e0` Reproduce the dropped turn on a strictly bound attach thread (HF1, red)
- `0070b73` Derive one session key for a strictly bound attach thread (HF1, green)
- `d998c1b` Reproduce the silent refusals that stranded a turn and its steer (HF1, red)
- `7794d0e` Answer a refused turn, steer or interrupt with a terminal, never silence (HF1, green)

Pushed to `origin/codex/hf1-attach-plugin-session-key`. Not merged, not tagged, not deployed.

## Deployment note for Kyle's Mac

Deployment goes through `scripts/install-bot-provisioner.sh`, which stages
`integrations/attach-plugin` into the provisioner release and reloads the watcher; the sweep in
`scripts/bot-provisioner-watch.sh` and `scripts/provision-bot.sh` then syncs the staged plugin into
each wired profile and, because the plugin content differs from what the profile is running,
restarts that profile's loaded service (`launchctl kickstart -k ai.hermes.gateway-<profile>`).

So installing this fix restarts every live profile once, not only the two broken bots. Each restart
drops in flight turns on that profile. Kyle decides when to run it.

## Fix round 1

Review r0 approved the core fix with no Critical and three Important findings; HF2 then defined
the capability 69 wire. All three findings are fixed, and the two free-text refusal constants are
gone.

**I1, the pre-dispatch check could not see either real drop path.** `_binding_still_derives` is
replaced by `_binding_dispatchable(binding, event)`, which runs Hermes' own two strict checks on
the frame about to be dispatched: the adapter seam's `self._event_session_key(event)` must equal
the bound key, and `async_session_store.lookup_by_session_key(bound key).session_id` must still be
the pinned id. A `/new`, a compaction retip or an eviction now produces a terminal in milliseconds
instead of a turn the gateway holds to its cap. Only a proven mismatch refuses: an unreachable
seam, an absent store or a raising lookup leaves the turn exactly as it was before the check
existed.

**I2, the multiplexed case.** New `_dispatch_session_key(source)` derives through the adapter seam,
which is the derivation Hermes follows at dispatch in both topologies (explicit route, then this
adapter's owner profile, then the store resolver), falling back to the runner seam when no adapter
seam exists. `_handle_desktop_resume_command` and `_baseline_mobile_mirror_link` both use it, so a
multiplexed gateway records the binding on the `agent:<owner profile>` lane its seams derive rather
than on the shared lane. Tested in both directions, including at the resume-command level.

**I3, the interrupt exemption keyed on arrival.** New bounded `_sealed_turns`, written by
`_mark_sealed` at the four places a terminal actually goes out (the command seal, the interrupt
seal, the reply path's commit or failed, and `_safe_failed`). The exemption reads that set, so a
turn that arrived and then died without a terminal now gets the typed refusal, and only a turn this
process really sealed is answered with silence.

**Row 69 adoption.** `failed.reason` is the closed `"unknown_turn"`, attached by
`AttachV1Client.send_failed` only when `hello_ack.extensions["com.cozylabs.bots"] >= 69`; below
that the frame is the one a pre-69 gateway has always received. Both refusals use it: a turn whose
strict binding this process cannot resolve is a turn it does not hold, and `unknown_turn` is the
only member of the closed set. `hello` carries `activeTurns` on every hello, including the empty
array, which the contract defines as a real declaration.

`activeTurns` is sent unconditionally rather than gated on the acked version, because hello
precedes `hello_ack` and the version is not knowable at that moment. That is safe here:
`AttachV1HelloSchema` (`packages/gateway/src/adapters/attach/protocol-v1.ts`) declares no
`additionalProperties: false`, validation goes through `assertValid` which uses TypeBox
`Value.Errors` and ignores unknown members, and `contract/attach-v1.md` states the
forward-compatibility rule for unknown members. So a gateway below 69 accepts and ignores the
field, and its behavior is byte identical. Only the resident adapter declares: the one-shot
proactive media client carries no turns, and an empty declaration from it would tell the gateway
this profile holds none at all, which under row 69 would seal the resident process's live turns.

RED for round 1, both files:

    <hermes venv>/bin/python -m unittest tests.test_session_key_binding tests.test_attach_client_v1
    Ran 26 tests - FAILED (failures=8, errors=7)

GREEN after the fixes, whole suite:

    <hermes venv>/bin/python -m unittest discover -s tests
    Ran 558 tests in 27.3s - OK (skipped=1)

Files touched in this round: `integrations/attach-plugin/cozygateway/adapter.py`,
`integrations/attach-plugin/cozygateway/attach_client_v1.py`,
`integrations/attach-plugin/tests/test_session_key_binding.py`,
`integrations/attach-plugin/tests/test_attach_client_v1.py`,
`integrations/attach-plugin/tests/test_desktop_session_resume.py` (its fake store now resolves the
bound key to the pinned session, which is what Hermes requires before it dispatches).

Commits: `60dd2a9` (red), `ca3ce64` (green).

Not addressed, deliberately: the review's Minor findings. M1 (an empty `HERMES_SESSION_PROFILE`
collapses Docker terminal containers onto one slot) needs a look at the live profiles before
anything is changed, and reading them was out of scope. M2 (two `failed` frames for one turn) is
narrowed by the sealed record but not closed, since the second frame is what the gateway's own
`native-sink` deduplication should refuse. M3 (a distinct log reason for the fail-closed profile
route) and M4 (the typed reason) are covered or minor; M4 landed here.
