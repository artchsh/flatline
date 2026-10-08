package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"time"
)

// runLoop collects and pushes forever.
//
// Timing: every interval seconds plus ±5s jitter, so ten agents provisioned at
// once do not push in lockstep. A failed push retries with backoff inside the
// tick budget; whatever happens, the next tick starts on schedule rather than
// drifting, because drift turns "every 60s" into "eventually".
func runLoop(cfg *Config) error {
	client := newPushClient(cfg)
	interval := time.Duration(cfg.IntervalSeconds) * time.Second

	log.Printf("superboard: pushing to %s every %ds", cfg.ServerURL, cfg.IntervalSeconds)

	// Push immediately on start so a fresh install shows up without waiting a
	// full interval. Operators watch the board after installing.
	if err := tick(client, cfg); err != nil {
		log.Printf("superboard: initial push failed: %v", err)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for range ticker.C {
		// Jitter after the tick, not instead of it: the average stays exact.
		jitter := time.Duration(rand.Int63n(10*time.Second.Nanoseconds()) - 5*time.Second.Nanoseconds())
		if jitter > 0 {
			time.Sleep(jitter)
		}

		if err := tick(client, cfg); err != nil {
			log.Printf("superboard: push failed: %v", err)
		}
	}

	return nil
}

// tick performs one collect-and-push cycle.
func tick(client *pushClient, cfg *Config) error {
	payload, err := collect()
	if err != nil {
		return fmt.Errorf("collect: %w", err)
	}

	// Retries must fit inside the tick: spending longer retrying than the
	// interval would stack pushes and lie about freshness.
	budget := time.Duration(cfg.IntervalSeconds) * time.Second / 2
	if budget < 10*time.Second {
		budget = 10 * time.Second
	}

	if err := pushWithBackoff(client, payload, budget); err != nil {
		return err
	}

	log.Printf(
		"superboard: pushed cpu=%.1f%% mem=%.1f%% disks=%d containers=%d",
		payload.CPU.Percent, payload.Mem.Percent, len(payload.Disk), len(payload.Docker),
	)

	return nil
}

// runOnce collects and pushes a single sample, printing the outcome.
//
// This is `superboard check`: provisioning ("did the server accept it?") and
// debugging ("what does this box report?") without reading journald.
func runOnce(cfg *Config, verbose bool) error {
	payload, err := collect()
	if err != nil {
		return fmt.Errorf("collect: %w", err)
	}

	if verbose {
		pretty, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return fmt.Errorf("encode payload: %w", err)
		}
		fmt.Println(string(pretty))
	}

	client := newPushClient(cfg)
	if err := client.push(payload); err != nil {
		return fmt.Errorf("push: %w", err)
	}

	log.Printf(
		"superboard check: ok (cpu=%.1f%% mem=%.1f%% disks=%d containers=%d gpu=%v)",
		payload.CPU.Percent, payload.Mem.Percent, len(payload.Disk), len(payload.Docker), payload.GPU.Available,
	)

	return nil
}
