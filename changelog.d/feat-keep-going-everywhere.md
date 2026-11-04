### Changed

- A routine run whose plan still has open steps now continues by itself in its own session, as a
  message in the agent's chat does. The run ends once, with the answer of its last turn. Before, the
  run stopped after its first turn.
- A turn that a message from another agent started now continues by itself while the agent's plan
  has open steps. The agent that asked gets one result, with the answer of the last turn. Before,
  the turn stopped after its first answer.
- After OpenBot restarts, an agent whose plan still had open steps continues the request once more,
  with a note that tells it to check the saved work first. Before, a restart dropped the rest of
  the work: the request ended after the turn that the restart stopped, or after the turn before an
  automatic continuation.
