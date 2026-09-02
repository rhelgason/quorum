# Architecture Decision Records

Short, dated records of decisions that were expensive to make and would be
expensive to silently reverse. Each one states what we chose, what we gave up,
and what would make us change our mind.

Format: Context → Decision → Consequences → Reversal cost.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-web-components-with-shadow-dom.md) | Web Components + shadow DOM, thin framework wrappers | Accepted |
| [0003](0003-ship-the-ui-not-just-the-backend.md) | Ship the UI, not just the backend | Accepted |
| [0004](0004-css-custom-properties-for-theming.md) | Theme with CSS custom properties, not a props API | Accepted |
| [0005](0005-deterministic-core-llm-at-render-edge.md) | Deterministic clustering core, LLM at the render edge | Accepted |
| [0006](0006-dom-serialization-over-screen-capture.md) | Serialize the DOM instead of capturing the screen | Accepted |
| [0007](0007-redact-by-default.md) | Redact by default, unmask by allowlist | Accepted |
| [0008](0008-native-mobile-ui-no-webview.md) | Native mobile UI, no webview | Accepted |
| [0009](0009-postgres-pgvector-single-datastore.md) | Postgres + pgvector, no second datastore | Accepted |
| [0010](0010-never-interrupt-the-frustrated-user.md) | Never interrupt the frustrated user | Accepted |

New ADRs: copy 0001's shape, take the next number, don't edit an accepted one —
supersede it with a new record and update the table.
