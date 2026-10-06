# F22 gateway budget disposition

## Scope

F21 recorded two load-sensitive CozyGateway observations separately from its
push-order test fix:

1. the captured attach-v1 session replay measured one health request at
   1090 ms while a broad suite was running;
2. the durable attach-v1 storage deletion test reached Vitest's default
   five-second timeout once while it used a temporary on-disk SQLite database.

This review inspected the tests and ingress/storage paths on current main. No
production or test timeout was changed.

## Captured-session health assertion

`attach-v1-captured-session-stress.test.ts` has an explicit thirty-second
whole-test ceiling. Each health probe independently uses an `AbortController`
with a one-second deadline and asserts a successful response in under one
second. The assertion and its request deadline agree, so there is no shorter
test wait hiding a longer configured operation deadline.

The ingress path admits and projects one WebSocket event synchronously, then
ACKs it. The test keeps at most 64 events and 4 MiB in flight. A health request
is intentionally issued at three acknowledged positions to prove this bounded
path remains responsive. Increasing its one-second threshold would weaken the
property F21 identified without a product deadline that supports a larger
value. The observed 1090 ms under a back-to-back broad suite is load evidence,
not a deterministic structural mismatch in this focused path.

## Durable storage assertion

`attach-v1-storage.test.ts` does not specify a per-test timeout, so Vitest's
five-second default applies. The named case performs only synchronous
`DatabaseSync` transactions, reads, and reopens against its temporary database;
it has no asynchronous operation with a configured deadline longer than five
seconds. The default therefore remains a useful guard against an unexpectedly
slow database operation. Raising it would mask the only reported symptom
without identifying a valid operation budget to preserve.

## Focused evidence

Using Node 24 on current main, one selected run of the two exact cases passed:

```text
attach-v1-captured-session-stress: 1 passed in 1170 ms
attach-v1-storage named case: 1 passed in 28 ms
```

The command selected only those two cases. No broad load suite, timeout sweep,
or production configuration change was run. A repeated load campaign remains
deferred until there is a reproducible failure or an explicit performance
qualification requirement.
