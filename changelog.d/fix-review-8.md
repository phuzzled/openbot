### Changed

- Only Claude agents get reminders (check-ins). Codex agents, like the other providers, show the line
  that the work stopped. You no longer need to change your Codex config for reminders.
- A promise with a time that OpenBot cannot read ("by end of week", "this week", "over the weekend")
  gets a late reminder at 09:00 seven days later, in place of no reminder.
- On a wake, an agent continues the request. Its note is its own reminder, not your approval.
