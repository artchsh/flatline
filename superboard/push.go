package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

// pushClient posts metrics to Flatline.
type pushClient struct {
	http *http.Client
	cfg  *Config
}

func newPushClient(cfg *Config) *pushClient {
	return &pushClient{
		http: &http.Client{Timeout: 30 * time.Second},
		cfg:  cfg,
	}
}

/**
 * Push one sample.
 *
 * Guardrails, in order of importance:
 * 1. Plain HTTP is refused unless explicitly allowed. Metrics (hostnames,
 *    container names, versions) are genuinely useful recon in cleartext.
 * 2. The server answers 400 for a bad metrics payload while still recording
 *    the heartbeat, so a 400 here means "fix the collector", never "the host
 *    is down". Do not retry a 400: it will fail identically next tick.
 */
func (c *pushClient) push(payload *Payload) error {
	server := strings.TrimRight(c.cfg.ServerURL, "/")

	if strings.HasPrefix(server, "http://") && !c.cfg.AllowInsecure {
		return fmt.Errorf("refusing plain HTTP to %s (set allow_insecure to override)", server)
	}

	url := fmt.Sprintf("%s/api/push/%s", server, c.cfg.PushToken)

	body, err := json.Marshal(map[string]any{
		"status":  "up",
		"msg":     "OK",
		"metrics": payload,
	})
	if err != nil {
		return fmt.Errorf("encode payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))

	if resp.StatusCode == http.StatusBadRequest {
		return &pushRejectedError{msg: strings.TrimSpace(string(respBody))}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("push: server returned %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
	}

	return nil
}

// pushRejectedError marks a 400: the server understood the request and said
// no. Retrying is pointless; the loop must wait for the next tick instead of
// hammering a deterministic failure with backoff.
type pushRejectedError struct {
	msg string
}

func (e *pushRejectedError) Error() string {
	return fmt.Sprintf("server rejected payload: %s", e.msg)
}

// pushWithBackoff tries a push, retrying transient failures with capped
// exponential backoff. A rejection (400) is returned immediately: it will
// fail identically on retry.
//
// A failed push is not reported as host-down locally. Silence is the signal,
// and the server already turns sustained silence into an alert.
func pushWithBackoff(client *pushClient, payload *Payload, maxElapsed time.Duration) error {
	wait := 2 * time.Second
	start := time.Now()

	for {
		err := client.push(payload)
		if err == nil {
			return nil
		}

		var rejected *pushRejectedError
		if errors.As(err, &rejected) {
			return err
		}

		if time.Since(start)+wait > maxElapsed {
			return fmt.Errorf("push failed after retries: %w", err)
		}

		// Jitter the wait so a fleet-wide outage does not retry in lockstep.
		jitter := time.Duration(rand.Int63n(int64(wait / 2)))
		time.Sleep(wait + jitter)

		wait *= 2
		if wait > 30*time.Second {
			wait = 30 * time.Second
		}
	}
}
