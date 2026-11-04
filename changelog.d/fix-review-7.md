### Changed

- In a reminder turn (a check-in), an agent cannot make or change a routine, close a wait of another
  agent, search the web, or read the resources of your MCP servers.
- After a restart during a reminder turn, the agent does not continue the plan of that turn.
- A Codex agent gets reminders only when its Codex config sets `features.apps`, `features.plugins`,
  `features.browser_use` and `features.computer_use` to `false`. Otherwise you see the line that the
  work stopped.
- When an agent continues its plan by itself, it asks you first before a step that sends, pays, books,
  deploys, deletes or contacts someone, and that you did not ask for. Your agent's approval settings
  still apply.
- A promise for "tomorrow" said before 05:00 means later today. "At 3:30" said in the afternoon means
  15:30. A promise for a date ("on the 20th", "next month") gets its reminder after that date. A promise
  with a time that OpenBot cannot read gets no reminder.
