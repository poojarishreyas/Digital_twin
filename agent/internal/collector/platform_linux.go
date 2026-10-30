//go:build linux

package collector

import (
	"bufio"
	"context"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/example/digital-twin/agent/internal/canonical"
	"github.com/example/digital-twin/agent/internal/model"
)

func collectHost(ctx context.Context, id string, now time.Time) (model.Host, []model.Gap) {
	hostname, _ := os.Hostname()
	version := ""
	kernel, _ := command(ctx, "uname", "-r")
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "PRETTY_NAME=") {
				version = strings.Trim(strings.TrimPrefix(l, "PRETTY_NAME="), "\"")
			}
		}
	}
	hw := map[string]string{"logical_cpus": strconv.Itoa(runtime.NumCPU())}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "MemTotal:") {
				hw["memory"] = strings.TrimSpace(strings.TrimPrefix(l, "MemTotal:"))
			}
		}
	}
	return model.Host{ID: id, Hostname: hostname, OS: "linux", OSVersion: version, Architecture: runtime.GOARCH, Kernel: kernel, Hardware: hw}, nil
}

func collectPlatform(ctx context.Context, host model.Host, now time.Time) ([]model.Component, []model.Relationship, []model.Gap) {
	var cs []model.Component
	var rs []model.Relationship
	var gaps []model.Gap
	versions := detectableVersions(ctx)
	if out, err := command(ctx, "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) < 4 {
				continue
			}
			name := strings.TrimSuffix(f[0], ".service")
			data := map[string]any{"name": name, "load": f[1], "state": f[2], "substate": f[3]}
			if version := versionFor(name, versions); version != "" {
				data["version"] = version
			}
			addComponent(&cs, &rs, host.ID, "service", "service:"+host.ID+":"+name, data, "systemd", now)
		}
	} else {
		gaps = append(gaps, gap("services", "systemd", classifyErr(err), err.Error(), now))
	}

	if out, err := command(ctx, "ss", "-H", "-lntup"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) < 5 {
				continue
			}
			proto := f[0]
			local := f[4]
			id := "listener:" + host.ID + ":" + proto + ":" + local
			data := map[string]any{"protocol": proto, "local": local, "process": strings.Join(f[6:], " ")}
			addComponent(&cs, &rs, host.ID, "listener", id, data, "ss", now)
		}
	} else {
		gaps = append(gaps, gap("sockets", "listeners", classifyErr(err), err.Error(), now))
	}

	if out, err := command(ctx, "ss", "-H", "-ntup", "state", "established"); err == nil {
		for i, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) < 5 {
				continue
			}
			local, remote := f[3], f[4]
			target := "endpoint:" + remote
			rs = append(rs, model.Relationship{Kind: "OBSERVED_CONNECTION", SourceID: host.ID, TargetID: target, Properties: map[string]any{"local": local, "remote": remote, "protocol": f[0], "ordinal": i}, Evidence: evidence("ss", now)})
		}
	} else {
		gaps = append(gaps, gap("sockets", "outbound", classifyErr(err), err.Error(), now))
	}

	if out, err := command(ctx, "sh", "-c", "if command -v iptables-save >/dev/null; then iptables-save; elif command -v nft >/dev/null; then nft list ruleset; else exit 127; fi"); err == nil {
		rules := parseFirewallRules(out)
		data := map[string]any{"format": firewallFormat(out), "rule_count": len(rules), "rules": rules}
		addComponent(&cs, &rs, host.ID, "firewall", "firewall:"+host.ID, data, "local-firewall", now)
	} else {
		gaps = append(gaps, gap("firewall", "rules", classifyErr(err), err.Error(), now))
	}

	uid := os.Geteuid()
	groups, groupErr := os.Getgroups()
	data := map[string]any{"uid": os.Getuid(), "effective_uid": uid, "is_elevated": uid == 0, "groups": groups}
	if groupErr != nil {
		gaps = append(gaps, gap("privilege", "groups", classifyErr(groupErr), groupErr.Error(), now))
	}
	if status, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, line := range strings.Split(string(status), "\n") {
			if strings.HasPrefix(line, "CapEff:") {
				data["effective_capabilities_hex"] = strings.TrimSpace(strings.TrimPrefix(line, "CapEff:"))
			}
		}
	}
	addComponent(&cs, &rs, host.ID, "privilege", "privilege:"+host.ID, data, "/proc", now)
	return cs, rs, gaps
}

func addComponent(cs *[]model.Component, rs *[]model.Relationship, hostID, kind, id string, data map[string]any, source string, now time.Time) {
	h, _ := canonical.Hash(data)
	*cs = append(*cs, model.Component{Kind: kind, ID: id, Hash: h, Data: data, Evidence: evidence(source, now)})
	*rs = append(*rs, model.Relationship{Kind: "HAS_" + strings.ToUpper(kind), SourceID: hostID, TargetID: id, Evidence: evidence(source, now)})
}
func classifyErr(err error) string {
	if os.IsPermission(err) || strings.Contains(strings.ToLower(err.Error()), "permission") {
		return "permission_denied"
	}
	return "unsupported_or_unavailable"
}
func firewallFormat(s string) string {
	if strings.Contains(s, "table inet") || strings.Contains(s, "table ip") {
		return "nftables"
	}
	return "iptables-save"
}
func parseFirewallRules(s string) []map[string]any {
	var rules []map[string]any
	scan := bufio.NewScanner(strings.NewReader(s))
	for scan.Scan() {
		line := strings.TrimSpace(strings.SplitN(scan.Text(), "#", 2)[0])
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		rule := map[string]any{}
		if len(fields) > 2 && fields[0] == "-A" {
			rule["chain"] = fields[1]
			for i := 2; i < len(fields)-1; i++ {
				switch fields[i] {
				case "-p":
					rule["protocol"] = fields[i+1]
				case "-s":
					rule["source"] = fields[i+1]
				case "-d":
					rule["destination"] = fields[i+1]
				case "--dport":
					rule["destination_port"] = fields[i+1]
				case "--sport":
					rule["source_port"] = fields[i+1]
				case "-j":
					rule["action"] = fields[i+1]
				case "-i":
					rule["input_interface"] = fields[i+1]
				case "-o":
					rule["output_interface"] = fields[i+1]
				}
			}
		} else {
			for i := 0; i < len(fields); i++ {
				switch fields[i] {
				case "tcp", "udp", "icmp", "icmpv6":
					rule["protocol"] = fields[i]
				case "accept", "drop", "reject":
					rule["action"] = fields[i]
				case "saddr":
					if i+1 < len(fields) {
						rule["source"] = fields[i+1]
					}
				case "daddr":
					if i+1 < len(fields) {
						rule["destination"] = fields[i+1]
					}
				case "dport":
					if i+1 < len(fields) {
						rule["destination_port"] = fields[i+1]
					}
				case "sport":
					if i+1 < len(fields) {
						rule["source_port"] = fields[i+1]
					}
				case "iifname":
					if i+1 < len(fields) {
						rule["input_interface"] = strings.Trim(fields[i+1], "\"")
					}
				case "oifname":
					if i+1 < len(fields) {
						rule["output_interface"] = strings.Trim(fields[i+1], "\"")
					}
				case "state":
					if i+1 < len(fields) {
						rule["state"] = fields[i+1]
					}
				}
			}
		}
		if len(fields) > 1 && (fields[0] == "table" || fields[0] == "chain") {
			rule["declaration"] = fields[0]
			rule["name"] = fields[len(fields)-1]
		}
		if len(rule) > 0 {
			rules = append(rules, rule)
		}
	}
	return rules
}

var processStarted = time.Now()

func processMetrics() (float64, uint64) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	var usage syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	cpu := float64(usage.Utime.Sec+usage.Stime.Sec) + float64(usage.Utime.Usec+usage.Stime.Usec)/1e6
	percent := cpu / time.Since(processStarted).Seconds() / float64(runtime.NumCPU()) * 100
	return percent, m.Sys
}
