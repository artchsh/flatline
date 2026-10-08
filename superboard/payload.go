package main

// Payload schema for Superboard metrics.
//
// Mirrors SUPERBOARD-SPEC.md §1.2: units are bytes for memory/disk totals,
// percent 0–100, uptime seconds. The agent and the board must never disagree
// about units, so they are documented here, next to the code that produces
// them.
//
// Absent capabilities are explicit, never omitted: gpu.available false means
// "no GPU", an empty docker list means "no Docker", an empty disk list means
// "could not read mounts". The server cannot distinguish "missing" from
// "broken" if we send nulls, and chasing that ghost is worse than no data.

/** Envelope version. Bump when fields change shape, never for additions. */
const payloadVersion = 1

// Host describes the machine itself.
type Host struct {
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Uptime   uint64 `json:"uptime"`
}

// CPU is a point sample over a 1s window, not an instantaneous reading.
type CPU struct {
	Percent float64 `json:"percent"`
	Cores   int     `json:"cores"`
}

// Mem holds bytes for totals and percent 0–100.
type Mem struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
}

// Disk is one mount. The agent sends every local mount it can read; the board
// shows the fullest first.
type Disk struct {
	Mount   string  `json:"mount"`
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
}

// GPU is best-effort by contract: failure yields Available false, never an
// error that stops the push.
type GPU struct {
	Available bool    `json:"available"`
	Util      float64 `json:"util,omitempty"`
	MemUsed   uint64  `json:"memUsed,omitempty"`
	MemTotal  uint64  `json:"memTotal,omitempty"`
	Temp      float64 `json:"temp,omitempty"`
	Name      string  `json:"name,omitempty"`
}

// Container is list + state, not stats. Per-container CPU/mem needs the stats
// stream and is explicitly phase 2.
type Container struct {
	Name   string   `json:"name"`
	Image  string   `json:"image"`
	State  string   `json:"state"`
	Health string   `json:"health,omitempty"`
	Ports  []string `json:"ports,omitempty"`
}

// Payload is the full document POSTed as `metrics` to /api/push/:token.
// Unknown fields are ignored server-side, so additions are safe.
type Payload struct {
	V      int         `json:"v"`
	Host   Host        `json:"host"`
	CPU    CPU         `json:"cpu"`
	Mem    Mem         `json:"mem"`
	Disk   []Disk      `json:"disk"`
	GPU    GPU         `json:"gpu"`
	Docker []Container `json:"docker"`
}
