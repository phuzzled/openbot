### Changed

- A routine run whose plan still has open steps now continues by itself in its own session, as a
  message in the agent's chat does. The run ends once, with the answer of its last turn. Before, the
  run stopped after its first turn.
