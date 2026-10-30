# Phase 1 lab verification

Use synthetic credentials and isolated Windows/Linux lab machines only.

1. Start the stack and enroll both agents with distinct client certificates. Use `agent.crt` on Windows and `agent-linux.crt` on Linux; each certificate's common name must match the envelope agent ID.
2. Confirm each appears current in the UI with sequence 1 and a full baseline.
3. Add an allowlisted Nginx directive; measure file-save to updated graph time.
4. Open/close a listening test socket; wait at most one polling interval and verify the listener component appears/disappears.
5. Stop a disposable service and verify its host-scoped service component is removed after a full reconciliation (force by restarting the agent if needed).
6. Disconnect an agent for three polls, create multiple changes, reconnect, and confirm ordered outbox replay plus a current final state without duplicate IDs.
7. Put `seeded-secret` in Redis `requirepass`, a URL password, and a non-allowlisted setting. Search agent output, ingestion output, PostgreSQL text exports, and Neo4j `data_json`; the marker must be absent.
8. Run one agent without permission to inspect firewall/service state and confirm visible `permission_denied` gaps.
9. Classify a known entry and critical asset, add lab evidence edges, and request `/api/paths?max_depth=4`. Verify every hop includes its evidence kind/timestamp.
10. Export `/api/measurements`; retain host hardware, polling interval, CPU, RAM, received bytes, collection time, event-to-collect time, and event-to-graph latency.

The automated test suites cover parser order/repetition, canonical hashing, schema rejection, redaction, and edge/evidence semantic separation. Database reconnect and two-OS collection remain lab acceptance tests because they require Windows, Linux, PostgreSQL, and Neo4j runtimes.

