### Added

- OpenBot now brings back an agent that stops with work still open. When an agent ends a turn with a
  promise such as "I'll let you know when they reply", or with open steps in its plan, and nothing is
  set to bring it back, OpenBot reminds it after 15 minutes. The reminder first tells the agent to
  stop if it waits for your answer or approval, and never to do an action that you did not approve.
  Only then does it ask the agent to report the state of the work, set a time to check back, ask
  you, or report that the work is done. A question to you, an answer that waits for you ("When you are ready, I'll
  start", "Let me know what you think") or for an approval ("After approval I'll deploy"), a timed
  wait in the same chat or task, your reply, or a Stop cancels the reminder. A message that the agent
  drafts for someone else, a teammate's message, or an older wait for other work with no set time
  does not. A promise to act when something happens ("As soon as the funds arrive, I'll pay the
  supplier", "Once Andrew replies, I'll send the contract") gets no reminder, so a reminder does not
  push an action that waits on a condition. An agent whose answer waits for you also does not
  continue its plan by itself. If the agent is busy when a reminder is due, the reminder waits. A
  reminder older than 24 hours is dropped. This works in the agent's chat and in its tasks, not in
  channels or routine runs. After 2 reminders for one request, OpenBot stops and shows a line in the
  chat that tells you that the work stopped. Set `OPENBOT_STALL_SWEEP=0` to turn it off.
