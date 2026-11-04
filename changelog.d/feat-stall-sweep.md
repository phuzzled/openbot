### Added

- OpenBot now brings back an agent that stops with work still open. When an agent ends a turn with a
  promise such as "I'll let you know when they reply", or with open steps in its plan, and nothing is
  set to bring it back, OpenBot reminds it after 15 minutes to finish the work, set a time to check
  back, ask you, or report that the work is done. A question to you, an open wait, your reply, or a
  Stop cancels the reminder. This works in the agent's chat and in its tasks, not in channels or
  routine runs. After 2 reminders for one request, OpenBot stops and shows a line in the chat that
  tells you that the work stopped. Set `OPENBOT_STALL_SWEEP=0` to turn it off.
