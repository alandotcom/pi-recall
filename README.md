# pi-extensions

A pi package with two extensions.

`recall` searches earlier messages in the current thread, including messages that pi dropped from
context when the session compacted.

`ask_async` asks the user a question and returns at once, so the agent keeps working while it waits
for the answer.

## recall

pi compacts a long session. Compaction replaces older messages with a summary. The messages stay in
the session file. They only stop reaching the model. `recall` reads them back.

A thread is the current session plus the sessions it was forked or cloned from, which pi records as
`parentSession` in the session header. `recall` searches that set and nothing else. If nothing
matches, it reports that nothing matched. An answer taken from unrelated work is worse than no
answer.

The current session is read from the session manager rather than from the file, so a search finds
the turn that happened a moment ago.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `query` | required | Literal text to look for. A distinctive identifier beats a phrase. |
| `limit` | `10` | Largest number of matches to return. |

Matching is literal substring. Results are ordered by recency, with a small lift for messages that
contain the query more than once. The whole result is capped at 6,000 characters.

## ask_async

The ordinary way to ask a user a question stops the turn. `ask_async` puts the question on screen
and returns immediately, so the model can continue with work that does not depend on the answer.
When the user answers, pi delivers the reply as a steered user message, which the agent receives
after the current tool calls finish.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `question` | required | The question, in one sentence. |
| `options` | none | Choices to offer. Omit for a free-text answer. |

If the user dismisses the question, nothing is sent and the agent continues with the assumption it
already made. In print mode and JSON mode there is nobody to ask, so the tool says so and tells the
model to proceed on a stated assumption.

Read the warning before you rely on it. Nothing stops the agent at the decision it asked about, so
an answer can arrive after the work went the other way. Ask about things you can still change.

## If you want to search every thread

This package searches one thread on purpose. Several pi packages search all of your sessions
instead, and they are better at that job:

| Package | Tools |
| --- | --- |
| `pi-session-search` | `session_search`, `session_list`, `session_read`, with keyword search and optional embeddings |
| `adobe/pi-session-search` | `search_sessions`, `read_session`, and a `/find-sessions` command |
| `@ogulcancelik/pi-session-recall` | `session_search`, plus `session_query` to ask a cheap model about one past session |
| `pi-session-finder` | `/find` to search every project and jump to the matching session |

Install one of those if you want to find work from another thread. Do not expect `recall` to grow
that ability. A match from unrelated work reads as authoritative and is usually wrong, which is the
reason this package stays narrow.

## Security

`recall` returns text that people wrote in earlier turns. Treat it as information, not as
instructions. If a hostile instruction was ever pasted into this thread, the model can read it again
later and try to follow it. The same is true of a secret: `recall` will show it again.

Reading one thread is a smaller risk than reading every session on disk, which is what a global
search tool gives a model. The risk is not zero. Do not give an agent that works on untrusted input
a tool that reads conversation history.

`recall` never writes. It reads the session file and the session manager, and nothing else.

## Install

```sh
pi install git:github.com/alandotcom/pi-extensions
```

To try it for one run without installing:

```sh
pi -e ./extensions/recall.ts -e ./extensions/ask-async.ts
```

## Make the agent use recall

An agent does not search its own history unless you tell it to. Add this to your `AGENTS.md`:

```md
## Search this thread first

Call `recall` before you re-read files, and before you decide anything that this thread already
decided. Always do this on your first turn after a compaction. Explore the code directly only if
`recall` returns nothing.
```

## License

MIT
