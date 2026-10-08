package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

// collectHost identifies the machine.
func collectHost() (Host, error) {
	info, err := host.Info()
	if err != nil {
		return Host{}, fmt.Errorf("host info: %w", err)
	}

	uptime, err := host.Uptime()
	if err != nil {
		// Uptime is informational; a failure here must not sink the push.
		log.Printf("warning: host uptime unavailable: %v", err)
	}

	hostname := info.Hostname
	if hostname == "" {
		hostname, _ = os.Hostname()
	}

	return Host{
		Hostname: hostname,
		OS:       info.OS,
		Uptime:   uptime,
	}, nil
}

// collectCPU samples over a 1s window. An instantaneous reading would mostly
// measure the sampler itself.
func collectCPU() (CPU, error) {
	cores, err := cpu.Counts(true)
	if err != nil {
		return CPU{}, fmt.Errorf("cpu cores: %w", err)
	}

	percents, err := cpu.Percent(time.Second, false)
	if err != nil {
		return CPU{}, fmt.Errorf("cpu percent: %w", err)
	}

	percent := 0.0
	if len(percents) > 0 {
		percent = percents[0]
	}

	return CPU{Percent: percent, Cores: cores}, nil
}

// collectMem reports bytes and percent.
func collectMem() (Mem, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return Mem{}, fmt.Errorf("memory: %w", err)
	}

	return Mem{Total: vm.Total, Used: vm.Used, Percent: vm.UsedPercent}, nil
}

// collectDisk reports every local mount it can read.
func collectDisk() ([]Disk, error) {
	partitions, err := disk.Partitions(false)
	if err != nil {
		return nil, fmt.Errorf("disk partitions: %w", err)
	}

	var out []Disk
	for _, p := range partitions {
		// Skip pseudo-filesystems: they report nonsense totals (/dev at 100%
		// on a healthy box is the classic false alarm).
		if strings.HasPrefix(p.Mountpoint, "/snap") ||
			strings.HasPrefix(p.Fstype, "squashfs") ||
			p.Mountpoint == "/proc" || strings.HasPrefix(p.Mountpoint, "/proc/") ||
			p.Mountpoint == "/sys" || strings.HasPrefix(p.Mountpoint, "/sys/") ||
			p.Mountpoint == "/dev" || strings.HasPrefix(p.Mountpoint, "/dev/") {
			continue
		}

		usage, err := disk.Usage(p.Mountpoint)
		if err != nil {
			log.Printf("warning: disk usage for %s unavailable: %v", p.Mountpoint, err)
			continue
		}

		out = append(out, Disk{
			Mount:   p.Mountpoint,
			Total:   usage.Total,
			Used:    usage.Used,
			Percent: usage.UsedPercent,
		})
	}

	return out, nil
}

// collectGPU shells out to nvidia-smi and parses the CSV output.
//
// Best-effort by contract: any failure (binary missing, parse error, driver
// mismatch) yields Available false, never an error that stops the push. A
// null GPU and a broken collector must be distinguishable server-side, and
// this is how.
func collectGPU() GPU {
	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return GPU{Available: false}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// CSV with exactly the fields we parse, in order.
	cmd := exec.CommandContext(ctx, path,
		"--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu",
		"--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		log.Printf("warning: nvidia-smi failed: %v", err)
		return GPU{Available: false}
	}

	records, err := csv.NewReader(strings.NewReader(strings.TrimSpace(string(out)))).ReadAll()
	if err != nil || len(records) == 0 {
		log.Printf("warning: nvidia-smi output unparseable: %v", err)
		return GPU{Available: false}
	}

	// First GPU only in v1; multi-GPU aggregation is a display concern.
	r := records[0]
	if len(r) < 5 {
		log.Printf("warning: nvidia-smi returned %d fields, want 5", len(r))
		return GPU{Available: false}
	}

	parse := func(s string) float64 {
		f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return f
	}
	parseBytes := func(s string) uint64 {
		// nvidia-smi reports MiB with --format=nounits.
		f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return uint64(f * 1024 * 1024)
	}

	return GPU{
		Available: true,
		Name:      strings.TrimSpace(r[0]),
		Util:      parse(r[1]),
		MemTotal:  parseBytes(r[2]),
		MemUsed:   parseBytes(r[3]),
		Temp:      parse(r[4]),
	}
}

// collect builds the full payload. Individual collectors degrade to empty or
// zero values with a logged warning; only a total failure to assemble aborts.
func collect() (*Payload, error) {
	h, err := collectHost()
	if err != nil {
		return nil, err
	}

	c, err := collectCPU()
	if err != nil {
		return nil, err
	}

	m, err := collectMem()
	if err != nil {
		return nil, err
	}

	disks, err := collectDisk()
	if err != nil {
		return nil, err
	}

	containers, err := collectDocker()
	if err != nil {
		// Docker absent is normal (most boxes run without it); absent data is
		// an empty list, not a failed push.
		log.Printf("warning: docker unavailable: %v", err)
		containers = nil
	}

	return &Payload{
		V:      payloadVersion,
		Host:   h,
		CPU:    c,
		Mem:    m,
		Disk:   disks,
		GPU:    collectGPU(),
		Docker: containers,
	}, nil
}
