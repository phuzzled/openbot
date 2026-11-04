### Changed

- A reminder that OpenBot sends to an agent that stopped with work open is now a check-in only. In
  that turn the agent can report the state of the work, set a time to check back, make a routine, ask
  you, or read. OpenBot blocks every other action, such as a send, a payment, a booking, a deploy, a
  delete, a shell command or a file change, also for an agent with Full access. This works for Claude
  agents, and for Codex agents when no MCP server is on. For other agents OpenBot cannot block
  actions, so it sends no reminder and shows the line that the work stopped.
- An agent does not continue its plan by itself when its next step sends, pays, books, publishes,
  deploys, deletes, signs or contacts someone, unless your message asked for that action. It also
  stops when its answer asks you anything or mentions an approval, a confirmation, a go-ahead or a
  review ("Please review and approve.", "Standing by for your go-ahead.").
- A promise for a later time ("Tomorrow I'll pay the supplier", "On Monday I'll send it", "In 2 hours
  I'll check") gets its reminder after that time, not after 15 minutes.
