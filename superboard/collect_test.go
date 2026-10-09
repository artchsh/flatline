package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParseDockerPSLineHealthy(t *testing.T) {
	c := parseDockerPSLine("a1b2c3d4e5f6|api|api:1.4.2|running|Up 3 days (healthy)|0.0.0.0:8080->80/tcp, :::8080->80/tcp")

	if c.Name != "api" {
		t.Fatalf("name = %q", c.Name)
	}
	if c.State != "running" {
		t.Fatalf("state = %q", c.State)
	}
	if c.Health != "healthy" {
		t.Fatalf("health = %q", c.Health)
	}
	if c.Uptime != 3*86400 {
		t.Fatalf("uptime = %d, want %d", c.Uptime, 3*86400)
	}
	if len(c.Ports) != 1 || c.Ports[0] != "8080:80" {
		t.Fatalf("ports = %v, want single 8080:80 (v4+v6 deduped)", c.Ports)
	}
}

func TestParseDockerPSLineUnhealthy(t *testing.T) {
	c := parseDockerPSLine("abc|worker|worker:latest|running|Up 5 minutes (unhealthy)|")
	if c.Health != "unhealthy" {
		t.Fatalf("health = %q", c.Health)
	}
	if c.Uptime != 5*60 {
		t.Fatalf("uptime = %d", c.Uptime)
	}
	if len(c.Ports) != 0 {
		t.Fatalf("ports = %v, want none", c.Ports)
	}
}

func TestParseDockerPSLineNotUp(t *testing.T) {
	for _, status := range []string{"Created", "Exited (0) 2 hours ago", "Restarting (1) 10 seconds ago", "Paused", "Dead"} {
		c := parseDockerPSLine("abc|old|old:1|created|" + status + "|")
		if c.Uptime != 0 {
			t.Fatalf("status %q: uptime = %d, want 0", status, c.Uptime)
		}
	}
}

func TestParseDockerUpTimeWords(t *testing.T) {
	cases := map[string]uint64{
		"Up 5 seconds":          5,
		"Up About a minute":     60,
		"Up about an hour":      3600,
		"Up 2 hours":            7200,
		"Up 3 days (healthy)":   3 * 86400,
		"Up 2 weeks":            2 * 604800,
		"Up Less than a second": 1,
		"Up 7 months":           7 * 2592000,
		"Up a minute":           60,
		"Up someday never":      0,
		"Up":                    0,
		"":                      0,
	}
	for status, want := range cases {
		if got := parseDockerUpTime(status); got != want {
			t.Errorf("status %q: uptime = %d, want %d", status, got, want)
		}
	}
}

func TestContainerUptime(t *testing.T) {
	if got := containerUptime(""); got != 0 {
		t.Fatalf("empty: got %d", got)
	}
	if got := containerUptime("not-a-date"); got != 0 {
		t.Fatalf("garbage: got %d", got)
	}
	started := time.Now().Add(-90 * time.Minute).UTC().Format(time.RFC3339)
	if got := containerUptime(started); got < 5400-5 || got > 5400+30 {
		t.Fatalf("90min ago: got %d", got)
	}
	if got := containerUptime(time.Now().Add(time.Hour).UTC().Format(time.RFC3339)); got != 0 {
		t.Fatalf("future: got %d, want 0", got)
	}
}

func TestDockerSocketPaths(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///tmp/custom.sock")
	paths := dockerSocketPaths()
	if len(paths) != 1 || paths[0] != "/tmp/custom.sock" {
		t.Fatalf("DOCKER_HOST override: %v", paths)
	}

	t.Setenv("DOCKER_HOST", "tcp://localhost:2375")
	paths = dockerSocketPaths()
	if len(paths) == 0 || strings.HasPrefix(paths[0], "tcp://") {
		t.Fatalf("tcp DOCKER_HOST must be ignored: %v", paths)
	}
}

func TestCollectDockerErrorMentionsPaths(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///tmp/does-not-exist-xyz.sock")
	// No docker CLI parsing involved: PATH without docker would also do, but
	// the error must name what was tried either way.
	_, err := collectDocker()
	if err == nil {
		t.Skip("docker unexpectedly reachable in test env")
	}
	if !strings.Contains(err.Error(), "/tmp/does-not-exist-xyz.sock") {
		t.Fatalf("error should name the tried socket: %v", err)
	}
}

func TestPayloadNewFieldsRoundTrip(t *testing.T) {
	p := Payload{
		V:   1,
		CPU: CPU{Percent: 10, Cores: 4, PerCore: []float64{10, 20}},
		Mem: Mem{Total: 8, Used: 4, Percent: 50},
		GPU: GPU{Available: true, Gpus: []GPUDetail{{Name: "g", Util: 70, MemTotal: 8, MemUsed: 4}}},
	}

	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}

	var back map[string]any
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}

	cpu := back["cpu"].(map[string]any)
	if len(cpu["perCore"].([]any)) != 2 {
		t.Fatalf("perCore missing: %v", cpu)
	}
	if _, ok := cpu["temp"]; ok {
		t.Fatal("zero temp must be omitted so the board hides it")
	}
	if _, ok := back["dockerError"]; ok {
		t.Fatal("empty dockerError must be omitted")
	}
}

func TestCollectCPUUsesTempHook(t *testing.T) {
	old := collectTemp
	collectTemp = func(keys []string) float64 { return 71.5 }
	defer func() { collectTemp = old }()

	c, err := collectCPU()
	if err != nil {
		t.Fatal(err)
	}
	if c.Temp != 71.5 {
		t.Fatalf("temp = %v", c.Temp)
	}
	if len(c.PerCore) == 0 {
		t.Fatal("perCore must not be empty")
	}
}
