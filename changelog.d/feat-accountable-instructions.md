### Changed

- Agents now check before they end a turn that the work is done, waits for the user, or has a wait
  that brings them back. They do not promise to check back without a wait or a routine, they turn
  "remind me" and "keep an eye on" into a routine, and they report Done, Needs you, Still working
  and Failed without being asked. A declined action stays declined for the task.
