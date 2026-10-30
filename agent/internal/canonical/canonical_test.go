package canonical

import "testing"

func TestMapOrderDoesNotChangeHash(t *testing.T) {
	a, _ := Hash(map[string]any{"a": 1, "b": 2})
	b, _ := Hash(map[string]any{"b": 2, "a": 1})
	if a != b {
		t.Fatalf("hashes differ: %s %s", a, b)
	}
}

func TestSliceOrderChangesHash(t *testing.T) {
	a, _ := Hash([]string{"allow", "deny"})
	b, _ := Hash([]string{"deny", "allow"})
	if a == b {
		t.Fatal("behavioral order was discarded")
	}
}
