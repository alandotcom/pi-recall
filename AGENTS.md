# Working in this repository

`pi-extensions` is a pi package with two extensions: `recall` searches this thread's own history, and
`ask_async` asks the user a question without stopping the turn.

## Rules that the design depends on

Never widen the search past the current thread. A thread is the current session plus the chain of
sessions it was forked or cloned from. Do not add an option that reaches other threads or every
session on disk. A match from unrelated work reads as authoritative and is usually wrong. An empty
result is the correct answer.

Never await the question in `ask_async`. Awaiting is exactly what makes an ordinary question tool
block the turn. The tool returns as soon as the question is on screen, and the answer arrives later
through `pi.sendUserMessage`.

Keep the result bounded. `recall` caps its whole response at 6,000 characters. A large tool result
is cheap on the turn that produces it and expensive on every turn after, because it stays in the
prompt.

## Constraints

- Read session files only. Never write to `~/.pi/agent/sessions`.
- Each extension is one self-contained file. pi loads every `.ts` file under `extensions/` as an
  extension, so a shared helper file placed there would load as one too.
- `ctx.hasUI` is false in print and JSON modes. Any user-facing prompt must degrade to a plain
  message instead of hanging.
- While a turn is streaming, `pi.sendUserMessage` requires `deliverAs`. Use `steer` so the answer
  reaches the agent at the first point it can act on it.

## Session format

Entries are JSONL, one per line, forming a tree through `id` and `parentId`. The first line is the
session header and carries `cwd` and, for a forked or cloned session, `parentSession`.

Message entries hold a `message` with a role of `user`, `assistant`, or `toolResult`. Read the
content parts of type `text`. Skip `thinking`, which is reasoning the search cannot use, and
`toolCall`, which is arguments rather than prose. A `compaction` entry holds a `summary` worth
searching.

## Before you commit

Load each extension and exercise it:

```sh
pi -p "Call recall with query \"something\" and limit 3, then report the match count." \
  -e ./extensions/recall.ts
```

Check the scope rule by searching for a term you know appears in a different thread. The result must
be "No matches in this thread".

## Prose

Comments explain a decision. The reader is new to this repository and knows what the package is for.
Put the history of the code in the commit message, not in a comment.
