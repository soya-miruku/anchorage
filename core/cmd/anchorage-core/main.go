package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"anchorage/core/internal/core"
	"anchorage/core/internal/rpc"
)

type stringList []string

func (values *stringList) String() string {
	return strings.Join(*values, ",")
}

func (values *stringList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("directory cannot be empty")
	}
	*values = append(*values, value)
	return nil
}

func main() {
	var dockerExecutable string
	var allowedCWDs stringList
	var showVersion bool
	flag.StringVar(&dockerExecutable, "docker", "docker", "Docker CLI executable name or path to resolve and fingerprint")
	flag.Var(&allowedCWDs, "allow-cwd", "Existing directory allowed as a cli.run working-directory root; repeatable")
	flag.BoolVar(&showVersion, "version", false, "Print core version and exit")
	flag.Parse()

	if showVersion {
		fmt.Printf("anchorage-core %s protocol %s go %s\n", core.CoreVersion, core.ProtocolVersion, runtime.Version())
		return
	}

	service, err := core.NewService(core.Config{
		DockerExecutable: dockerExecutable,
		AllowedCWDRoots:  allowedCWDs,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "anchorage-core:", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = os.Stdin.Close()
	}()

	server := rpc.NewServer(service, os.Stdin, os.Stdout)
	if err := server.Serve(ctx); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "anchorage-core:", err)
		os.Exit(1)
	}
}
