package collector

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/example/digital-twin/agent/internal/canonical"
	"github.com/example/digital-twin/agent/internal/model"
)

// workloadDeclaration supplies deployment provenance; the listener and outbound
// connections are independently observed from the running network namespace.
type workloadDeclaration struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	ImageID       string `json:"image_id"`
	Port          int    `json:"port"`
	Authorization string `json:"authorization,omitempty"`
}

func collectWorkload(path, host string, now time.Time) ([]model.Component, []model.Relationship, []model.Gap) {
	var cs []model.Component
	var rs []model.Relationship
	fail := func(reason string) ([]model.Component, []model.Relationship, []model.Gap) {
		return nil, nil, []model.Gap{gap("workload", "deployment", "unsupported_or_unavailable", reason, now)}
	}
	f, err := os.Open(path)
	if err != nil {
		return fail("workload declaration unavailable")
	}
	defer f.Close()
	var d workloadDeclaration
	decoder := json.NewDecoder(io.LimitReader(f, 16385))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&d) != nil || !regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`).MatchString(d.Name) || len(d.Version) > 128 || d.Version == "" || !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(d.ImageID) || d.Port < 1 || d.Port > 65535 {
		return fail("invalid workload declaration")
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(d.Port)), time.Second)
	if err != nil {
		return fail("declared workload has no reachable local listener")
	}
	connection.Close()
	addresses := []string{}
	interfaces, _ := net.InterfaceAddrs()
	for _, address := range interfaces {
		ip, _, err := net.ParseCIDR(address.String())
		if err == nil && ip.To4() != nil && !ip.IsLoopback() {
			addresses = append(addresses, ip.String())
		}
	}
	add := func(kind, id string, data map[string]any, source string) {
		hash, _ := canonical.Hash(data)
		cs = append(cs, model.Component{Kind: kind, ID: id, Hash: hash, Data: data, Evidence: evidence(source, now)})
		relKind := "HAS_" + strings.ToUpper(kind)
		if kind == "configuration" {
			relKind = "HAS_CONFIGURATION"
		}
		rs = append(rs, model.Relationship{Kind: relKind, SourceID: host, TargetID: id, Evidence: evidence(source, now)})
	}
	add("service", "service:"+host+":"+d.Name, map[string]any{"name": d.Name, "version": d.Version, "image_id": d.ImageID, "state": "running", "provenance": "deployment-declaration-and-live-listener"}, "workload:local-listener")
	add("listener", "listener:"+host+":workload", map[string]any{"local": fmt.Sprintf("0.0.0.0:%d", d.Port), "addresses": addresses, "port": d.Port, "protocol": "tcp"}, "workload:local-listener-and-interfaces")
	add("configuration", "config:"+host+":workload", map[string]any{"service": d.Name, "release": d.Version, "image_id": d.ImageID, "authorization": d.Authorization}, "workload:deployment-declaration")
	if runtime.GOOS != "linux" {
		return cs, rs, []model.Gap{gap("workload", "connections", "unsupported", "kernel socket discovery for this workload profile requires Linux", now)}
	}
	raw, err := os.ReadFile("/proc/net/tcp")
	if err != nil {
		return cs, rs, []model.Gap{gap("workload", "connections", "inaccessible", "kernel socket table unavailable", now)}
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[3] != "01" {
			continue
		}
		remote, err := procEndpoint(fields[2])
		if err != nil || seen[remote] {
			continue
		}
		local, _ := procEndpoint(fields[1])
		seen[remote] = true
		rs = append(rs, model.Relationship{Kind: "OBSERVED_CONNECTION", SourceID: host, TargetID: "endpoint:" + remote, Properties: map[string]any{"local": local, "remote": remote, "protocol": "tcp"}, Evidence: evidence("/proc/net/tcp", now)})
	}
	return cs, rs, nil
}

func procEndpoint(value string) (string, error) {
	pair := strings.Split(value, ":")
	if len(pair) != 2 || len(pair[0]) != 8 {
		return "", fmt.Errorf("invalid kernel endpoint")
	}
	bytes, err := hex.DecodeString(pair[0])
	if err != nil {
		return "", err
	}
	port, err := strconv.ParseUint(pair[1], 16, 16)
	if err != nil {
		return "", err
	}
	ip := net.IPv4(bytes[3], bytes[2], bytes[1], bytes[0])
	return net.JoinHostPort(ip.String(), strconv.Itoa(int(port))), nil
}
