package model

import (
	"encoding/json"
	"testing"
)

func TestEmptyDeltaUsesSchemaArraysAndCanBeRetried(t *testing.T) {
	envelope := Envelope{SchemaVersion: SchemaVersion, AgentID: "agent-protocol-test", Sequence: 2}
	for attempt := 0; attempt < 2; attempt++ {
		data, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		var document map[string]any
		if err = json.Unmarshal(data, &document); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"components", "relationships", "gaps"} {
			if _, ok := document[name].([]any); !ok {
				t.Fatalf("required %s collection is not an array", name)
			}
		}
		// Retry serialization after an outbox round trip must preserve this contract.
		if err = json.Unmarshal(data, &envelope); err != nil {
			t.Fatal(err)
		}
	}
}
