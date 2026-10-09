package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
)

type liveCollector struct {
	mu               sync.RWMutex
	host             Host
	started          time.Time
	disk             []Disk
	gpu              GPU
	docker           []Container
	dockerError      string
	cpuTemp, memTemp float64
}

func refreshLoop(ctx context.Context, interval time.Duration, collect func()) {
	collect()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collect()
		}
	}
}

func newLiveCollector(ctx context.Context) (*liveCollector, error) {
	h, err := collectHost()
	if err != nil {
		return nil, err
	}
	// Prime the delta sampler once; subsequent calls cover elapsed time
	// without a blocking one-second sleep in the collection path.
	if _, err := cpu.Percent(0, true); err != nil {
		return nil, err
	}
	c := &liveCollector{host: h, started: time.Now(), dockerError: "Collector initializing"}
	go refreshLoop(ctx, 30*time.Second, func() {
		disks, err := collectDisk()
		if err != nil {
			log.Printf("disk: %v", err)
			return
		}
		c.mu.Lock()
		c.disk = disks
		c.mu.Unlock()
	})
	go refreshLoop(ctx, 30*time.Second, func() {
		cpuTemp, memTemp := collectTemp(cpuSensorKeys), collectTemp(memSensorKeys)
		c.mu.Lock()
		c.cpuTemp, c.memTemp = cpuTemp, memTemp
		c.mu.Unlock()
	})
	go refreshLoop(ctx, 5*time.Second, func() {
		gpu := collectGPU()
		c.mu.Lock()
		c.gpu = gpu
		c.mu.Unlock()
	})
	go refreshLoop(ctx, 10*time.Second, func() {
		containers, err := collectDocker()
		errorText := ""
		if err != nil {
			errorText = err.Error()
			log.Printf("docker: %v", err)
		}
		c.mu.Lock()
		c.docker, c.dockerError = containers, errorText
		c.mu.Unlock()
	})
	return c, nil
}

func (c *liveCollector) sample() (*Payload, error) {
	percent, err := cpu.Percent(0, true)
	if err != nil {
		return nil, fmt.Errorf("cpu: %w", err)
	}
	vm, err := mem.VirtualMemory()
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}
	total := 0.0
	for _, value := range percent {
		total += value
	}
	if len(percent) > 0 {
		total /= float64(len(percent))
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	h := c.host
	h.Uptime += uint64(time.Since(c.started).Seconds())
	return &Payload{V: payloadVersion, Host: h,
		CPU:  CPU{Percent: total, Cores: len(percent), PerCore: percent, Temp: c.cpuTemp},
		Mem:  Mem{Total: vm.Total, Used: vm.Used, Percent: vm.UsedPercent, Temp: c.memTemp},
		Disk: c.disk, GPU: c.gpu, Docker: c.docker, DockerError: c.dockerError}, nil
}
