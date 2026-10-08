package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

// Docker socket path. The agent only reads; it never creates, starts, or
// stops anything, which is worth stating because the socket is root-equivalent
// and whoever audits this will ask.
const dockerSocketPath = "/var/run/docker.sock"

// dockerListItem is the subset of /containers/json we care about.
type dockerListItem struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	Image  string   `json:"Image"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
	Ports  []struct {
		IP          string `json:"IP"`
		PrivatePort uint16 `json:"PrivatePort"`
		PublicPort  uint16 `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
}

// dockerInspect is the subset of /containers/{id}/json we care about.
type dockerInspect struct {
	Config struct {
		Healthcheck *struct{} `json:"Healthcheck"`
	} `json:"Config"`
	State struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
	} `json:"NetworkSettings"`
}

// dockerClient talks to the daemon over its Unix socket with the standard
// library only. The full docker client library is a large dependency for two
// GET endpoints, and pinning its API version matrix is its own maintenance
// burden. If the surface ever grows past list + inspect, revisit.
type dockerClient struct {
	http *http.Client
}

func newDockerClient() *dockerClient {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", dockerSocketPath)
		},
	}

	return &dockerClient{
		http: &http.Client{Transport: transport, Timeout: 10 * time.Second},
	}
}

func (c *dockerClient) get(path string, out any) error {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker API %s: %s", path, resp.Status)
	}

	return json.NewDecoder(resp.Body).Decode(out)
}

// collectDocker lists containers with state, health and exposed ports.
//
// No stats streaming in v1: per-container CPU/mem needs the stats endpoint
// held open per container, which is heavier on both ends. List + state answers
// "what is running and is it healthy", which is the v1 question.
func collectDocker() ([]Container, error) {
	client := newDockerClient()

	var list []dockerListItem
	if err := client.get("/v1.43/containers/json?all=1", &list); err != nil {
		return nil, err
	}

	out := make([]Container, 0, len(list))
	for _, item := range list {
		name := strings.TrimPrefix(item.Names[0], "/")
		if len(item.Names) == 0 {
			name = item.ID[:12]
		}

		c := Container{
			Name:  name,
			Image: item.Image,
			State: item.State,
		}

		// Health and ports come from inspect; a failure for one container
		// degrades that container, never the whole list.
		var insp dockerInspect
		if err := client.get("/v1.43/containers/"+item.ID+"/json", &insp); err != nil {
			log.Printf("warning: docker inspect %s failed: %v", name, err)
		} else {
			if insp.State.Health != nil {
				c.Health = insp.State.Health.Status
			}
			for containerPort, bindings := range insp.NetworkSettings.Ports {
				private := strings.Split(containerPort, "/")[0]
				if len(bindings) == 0 {
					c.Ports = append(c.Ports, private)
					continue
				}
				for _, b := range bindings {
					c.Ports = append(c.Ports, fmt.Sprintf("%s:%s", b.HostPort, private))
				}
			}
		}

		// Fall back to the list-response ports when inspect gave nothing.
		if len(c.Ports) == 0 {
			for _, p := range item.Ports {
				if p.PublicPort != 0 {
					c.Ports = append(c.Ports, fmt.Sprintf("%d:%d", p.PublicPort, p.PrivatePort))
				} else {
					c.Ports = append(c.Ports, fmt.Sprintf("%d", p.PrivatePort))
				}
			}
		}

		out = append(out, c)
	}

	if out == nil {
		out = []Container{}
	}

	return out, nil
}
