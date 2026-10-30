//go:build windows

package collector

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/example/digital-twin/agent/internal/canonical"
	"github.com/example/digital-twin/agent/internal/model"
	"golang.org/x/sys/windows"
)

func collectHost(ctx context.Context, id string, now time.Time) (model.Host, []model.Gap) {
	hostname, _ := os.Hostname()
	version, err := command(ctx, "cmd", "/c", "ver")
	var gaps []model.Gap
	if err != nil {
		gaps = append(gaps, gap("identity", "os_version", classifyErr(err), err.Error(), now))
	}
	return model.Host{ID: id, Hostname: hostname, OS: "windows", OSVersion: version, Architecture: runtime.GOARCH, Hardware: map[string]string{"logical_cpus": strconv.Itoa(runtime.NumCPU())}}, gaps
}

func collectPlatform(ctx context.Context, host model.Host, now time.Time) ([]model.Component, []model.Relationship, []model.Gap) {
	var cs []model.Component
	var rs []model.Relationship
	var gaps []model.Gap
	versions := detectableVersions(ctx)
	ps := func(script string) (string, error) {
		return command(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	}
	if out, err := ps(`Get-CimInstance Win32_Service | Select-Object Name,State,StartMode,PathName | ConvertTo-Json -Compress`); err == nil {
		for _, row := range jsonRows(out) {
			name, _ := row["Name"].(string)
			data := map[string]any{"name": name, "state": row["State"], "start_mode": row["StartMode"]}
			if version := versionFor(name, versions); version != "" {
				data["version"] = version
			}
			addComponent(&cs, &rs, host.ID, "service", "service:"+host.ID+":"+strings.ToLower(name), data, "Win32_Service", now)
		}
	} else {
		gaps = append(gaps, gap("services", "scm", classifyErr(err), err.Error(), now))
	}
	if out, err := ps(`Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`); err == nil {
		for _, row := range jsonRows(out) {
			local := anyString(row["LocalAddress"]) + ":" + anyString(row["LocalPort"])
			data := map[string]any{"protocol": "tcp", "local": local, "pid": row["OwningProcess"]}
			addComponent(&cs, &rs, host.ID, "listener", "listener:"+host.ID+":tcp:"+local, data, "Get-NetTCPConnection", now)
		}
	} else {
		gaps = append(gaps, gap("sockets", "listeners", classifyErr(err), err.Error(), now))
	}
	if out, err := ps(`Get-NetTCPConnection -State Established | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess | ConvertTo-Json -Compress`); err == nil {
		for i, row := range jsonRows(out) {
			remote := anyString(row["RemoteAddress"]) + ":" + anyString(row["RemotePort"])
			rs = append(rs, model.Relationship{Kind: "OBSERVED_CONNECTION", SourceID: host.ID, TargetID: "endpoint:" + remote, Properties: map[string]any{"local": anyString(row["LocalAddress"]) + ":" + anyString(row["LocalPort"]), "remote": remote, "protocol": "tcp", "pid": row["OwningProcess"], "ordinal": i}, Evidence: evidence("Get-NetTCPConnection", now)})
		}
	} else {
		gaps = append(gaps, gap("sockets", "outbound", classifyErr(err), err.Error(), now))
	}
	if out, err := ps(`Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress`); err == nil {
		rulesOut, rulesErr := ps(`Get-NetFirewallRule -Enabled True | Select-Object DisplayName,Direction,Action,Profile | ConvertTo-Json -Compress`)
		data := map[string]any{"profiles": jsonRows(out)}
		if rulesErr == nil {
			data["rules"] = jsonRows(rulesOut)
		} else {
			gaps = append(gaps, gap("firewall", "enabled_rules", classifyErr(rulesErr), rulesErr.Error(), now))
		}
		addComponent(&cs, &rs, host.ID, "firewall", "firewall:"+host.ID, data, "Get-NetFirewallProfile", now)
	} else {
		gaps = append(gaps, gap("firewall", "rules", classifyErr(err), err.Error(), now))
	}
	if out, err := ps(`[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent() | ForEach-Object { [pscustomobject]@{Name=$_.Identity.Name; IsAdministrator=$_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} } | ConvertTo-Json -Compress`); err == nil {
		var data map[string]any
		_ = json.Unmarshal([]byte(out), &data)
		addComponent(&cs, &rs, host.ID, "privilege", "privilege:"+host.ID, data, "WindowsPrincipal", now)
	} else {
		gaps = append(gaps, gap("privilege", "token", classifyErr(err), err.Error(), now))
	}
	return cs, rs, gaps
}

func jsonRows(s string) []map[string]any {
	var rows []map[string]any
	if strings.HasPrefix(strings.TrimSpace(s), "[") {
		_ = json.Unmarshal([]byte(s), &rows)
		return rows
	}
	var one map[string]any
	if json.Unmarshal([]byte(s), &one) == nil && one != nil {
		return []map[string]any{one}
	}
	return rows
}
func anyString(v any) string {
	return strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(toJSON(v), "\"", ""), ".0", "")), "["), "]")
}
func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func addComponent(cs *[]model.Component, rs *[]model.Relationship, hostID, kind, id string, data map[string]any, source string, now time.Time) {
	h, _ := canonical.Hash(data)
	*cs = append(*cs, model.Component{Kind: kind, ID: id, Hash: h, Data: data, Evidence: evidence(source, now)})
	*rs = append(*rs, model.Relationship{Kind: "HAS_" + strings.ToUpper(kind), SourceID: hostID, TargetID: id, Evidence: evidence(source, now)})
}
func classifyErr(err error) string {
	if os.IsPermission(err) || strings.Contains(strings.ToLower(err.Error()), "access is denied") {
		return "permission_denied"
	}
	return "unsupported_or_unavailable"
}

var processStarted = time.Now()

func processMetrics() (float64, uint64) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	var created, exited, kernel, user windows.Filetime
	cpu := 0.0
	if windows.GetProcessTimes(windows.CurrentProcess(), &created, &exited, &kernel, &user) == nil {
		cpu = float64(kernel.Nanoseconds()+user.Nanoseconds()) / 1e9 / time.Since(processStarted).Seconds() / float64(runtime.NumCPU()) * 100
	}
	return cpu, m.Sys
}
