### Changed

- A routine run whose plan still has open steps now continues by itself in its own session, as a
  message in the agent's chat does. The run ends once, with the answer of its last turn. Before, the
  run stopped after its first turn.
- A turn that a message from another agent started now continues by itself while the agent's plan
  has open steps. The agent that asked gets one result, with the answer of the last turn. Before,
  the turn stopped after its first answer. When the chain ends early, for example after a Stop, the
  agent that asked still gets the latest answer once.
- After OpenBot restarts, an agent whose plan still had open steps continues the request once more,
  with a note that tells it to check the saved work first, and to check that a send, post, payment
  or other action that cannot be undone did not already happen before it repeats it. A turn that
  the restart cut off after it sent a message to another agent or changed a hosted site does not
  continue: it ends as interrupted, as before. Before, a restart dropped the rest of
  the work: the request ended after the turn that the restart stopped, or after the turn before an
  automatic continuation.
