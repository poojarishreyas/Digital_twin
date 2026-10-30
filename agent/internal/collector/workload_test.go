package collector

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWorkloadRequiresRunningListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	path := filepath.Join(t.TempDir(), "workload.json")
	data, _ := json.Marshal(workloadDeclaration{Name: "company-api", Version: "company-records/1.0.0", ImageID: "sha256:" + strings.Repeat("a", 64), Port: port, Authorization: "authentication_only"})
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	components, relationships, _ := collectWorkload(path, "agent-workload-example", time.Now().UTC())
	if len(components) != 3 || len(relationships) < 3 {
		t.Fatal("live service, configuration and listener were not discovered")
	}
	if components[0].Evidence.Confidence != "observed" {
		t.Fatal("workload incorrectly claimed confirmed evidence")
	}
	listener.Close()
	components, _, gaps := collectWorkload(path, "agent-workload-example", time.Now().UTC())
	if len(components) != 0 || len(gaps) == 0 {
		t.Fatal("stopped service was silently reported as running")
	}
}

func TestKernelEndpointDecoding(t *testing.T) {
	endpoint, err := procEndpoint("020011AC:1F90")
	if err != nil || endpoint != "172.17.0.2:"+strconv.Itoa(8080) {
		t.Fatalf("unexpected endpoint %q", endpoint)
	}
	for _, input := range []string{"bad", "FFFFFFFF:INVALID", "NOTANIP0:1F90"} {
		if _, err := procEndpoint(input); err == nil {
			t.Fatal("invalid endpoint accepted")
		}
	}
}
