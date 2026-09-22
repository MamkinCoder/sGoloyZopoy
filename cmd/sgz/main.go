// Command sgz is the single binary: panel server, scheduler, run orchestrator and ops CLI.
//
// Subcommands (wired by workstreams; this file is the shared entrypoint):
//
//	sgz serve                                   HTTP API + SPA + scheduler + run queue
//	sgz run [--user slug|all] [--source hh|career|all|pool] [--dry-run] [--limit N] [--stage X]
//	sgz hh-login --user slug                    headed browser, wait for login, export cookies
//	sgz hh-session check|import|reset --user slug
//	sgz hh-record --user slug --vacancy <id|url> [--negotiation id]
//	sgz pool sync|expand|touch --user slug
//	sgz resume import <tex> --user slug --name go|fullstack
//	sgz resume build --user slug --cv name [--vacancy id]
//	sgz db migrate|backup
//	sgz version
package main

import (
	"fmt"
	"os"
)

var version = "dev"

// subcommands is filled by init() functions in sibling files (serve.go, run.go, ...).
var subcommands = map[string]func(args []string) error{}

func register(name string, fn func(args []string) error) { subcommands[name] = fn }

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	name := os.Args[1]
	if name == "version" {
		fmt.Println(version)
		return
	}
	fn, ok := subcommands[name]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown command %q\n", name)
		usage()
		os.Exit(2)
	}
	if err := fn(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: sgz <command> [flags]")
	for name := range subcommands {
		fmt.Fprintln(os.Stderr, "  ", name)
	}
	fmt.Fprintln(os.Stderr, "   version")
}
