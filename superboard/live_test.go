package main

import (
	"testing"
	"time"
)

func TestOfferLatestNeverBuildsBacklog(t *testing.T) {
	samples := make(chan *Payload, 1)
	for i := 0; i < 10000; i++ {
		offerLatest(samples, &Payload{CPU: CPU{Percent: float64(i)}})
	}
	if len(samples) != 1 {
		t.Fatalf("pending=%d", len(samples))
	}
	if got := (<-samples).CPU.Percent; got != 9999 {
		t.Fatalf("latest=%v", got)
	}
}

func TestLiveSampleDoesNotWaitForSlowCollectors(t *testing.T) {
	c := &liveCollector{host: Host{Hostname: "test", Uptime: 100}, started: time.Now(), dockerError: "Collector initializing", cpuTemp: 65}
	started := time.Now()
	p, err := c.sample()
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(started) >= time.Second {
		t.Fatal("live sample has a blocking CPU window")
	}
	if p.CPU.Temp != 65 || p.Host.Hostname != "test" || p.DockerError != "Collector initializing" {
		t.Fatalf("cached slow data lost: %+v", p)
	}
	if len(p.CPU.PerCore) == 0 {
		t.Fatal("missing per-core data")
	}
}
