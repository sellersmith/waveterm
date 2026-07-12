// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package backend_test

import (
	"bytes"
	"crypto/sha256"
	"debug/macho"
	"encoding/hex"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

const stableCommit = "97e560027f494d20fed347b2d6b72b6bcb3e50e0"

var backendSeamHashes = map[string]string{
	"pkg/blockcontroller/blockcontroller.go": "c9cb274dba7c4757d959c393436a505b6c7f8a08381c7d6158c6f56643176ebf",
	"pkg/blockcontroller/shellcontroller.go": "761e72e6a239e1e04abbb959cd96ba1d7b8f3ad90d68f29a9b3b350ec7a63454",
	"pkg/filestore/blockstore.go":            "17ca52c4288191e5eaf62672824b8e61b91fe308f94586a535dccfd95543655d",
	"pkg/service/service.go":                 "2d5bee7e31337caf3f93a75b11f0874b430513cdf46692a28b3d4adef9e48444",
	"pkg/shellexec/conninterface.go":         "5b8c07390767c6cc31d30f7b14a83f5829260bec3afa31e2b3e467219890145a",
	"pkg/wavejwt/wavejwt.go":                 "2c86c3385c7fc12a2bf2679c5b3a322e81ea17f70e0613213548ecb6c4956e9a",
	"pkg/wcore/block.go":                     "d8dfd8b4c7152f2b248b78d3358daff1d9619e4e0f7e0135d15f583d3e886882",
	"pkg/wcore/wcore.go":                     "31db2690a6ca826152149b56ea214ebfca34e8a56d411ded0c8967e7830eab9d",
	"pkg/wcore/workspace.go":                 "e95eac1fab410caa2c6922ab3dea597573f5fd609583c8834d7265a2c410d553",
	"pkg/web/ws.go":                          "06bb48aaba607ce877f28397591d9ea18f658bc264c73da03617f1626e2a9a45",
	"pkg/wshrpc/wshrpctypes_file.go":         "a265146a386f3a493170a7f8ab8dcab4e7b588b2bf839be128487b5ed4185856",
}

var downstreamFiles = []string{
	"hyprlane/cmd/wavesrv/main.go",
	"hyprlane/cmd/wavesrv/features_gen.go",
	"hyprlane/cmd/wavesrv/wshserver_gen.go",
	"hyprlane/cmd/wavesrv/httpserver.go",
	"hyprlane/cmd/wavesrv/runtime.go",
	"hyprlane/cmd/wsh/main.go",
}

var requiredNativeTerminalMethods = []string{
	"ControllerDestroyCommand",
	"ControllerInputCommand",
	"ControllerResyncCommand",
	"CreateBlockCommand",
	"CreateSubBlockCommand",
	"DeleteBlockCommand",
	"DeleteSubBlockCommand",
	"EventPublishCommand",
	"EventSubCommand",
	"EventUnsubCommand",
	"GetRTInfoCommand",
	"SetMetaCommand",
	"SetRTInfoCommand",
	"WaitForRouteCommand",
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func commandOutput(t *testing.T, root string, args ...string) string {
	t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOTOOLCHAIN=go1.25.6")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func goDependencies(t *testing.T, root string, target string) map[string]bool {
	t.Helper()
	out := commandOutput(t, root, "go", "list", "-deps", "-f", "{{.ImportPath}}", target)
	deps := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			deps[line] = true
		}
	}
	return deps
}

func assertDependencies(t *testing.T, deps map[string]bool, expected ...string) {
	t.Helper()
	for _, dependency := range expected {
		if !deps[dependency] {
			t.Errorf("expected dependency %q in stable closure", dependency)
		}
	}
}

func assertNoDependencyPrefixes(t *testing.T, deps map[string]bool, forbidden ...string) {
	t.Helper()
	for dependency := range deps {
		for _, prefix := range forbidden {
			if dependency == prefix || strings.HasPrefix(dependency, prefix+"/") {
				t.Errorf("forbidden dependency %q in downstream closure", dependency)
			}
		}
	}
}

func buildBinary(t *testing.T, root string, target string, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	cmd := exec.Command(
		"go",
		"build",
		"-trimpath",
		"-tags",
		"osusergo,sqlite_omit_load_extension",
		"-o",
		path,
		target,
	)
	cmd.Dir = root
	cmd.Env = append(
		os.Environ(),
		"CGO_ENABLED=1",
		"GOARCH=arm64",
		"GOOS=darwin",
		"GOTOOLCHAIN=go1.25.6",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build %s: %v\n%s", target, err, out)
	}
	return path
}

func assertBinaryStrings(t *testing.T, path string, expected ...string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range expected {
		if !bytes.Contains(data, []byte(value)) {
			t.Errorf("expected %q in stable binary %s", value, filepath.Base(path))
		}
	}
}

func assertNoBinaryStrings(t *testing.T, path string, forbidden ...string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range forbidden {
		if bytes.Contains(data, []byte(value)) {
			t.Errorf("forbidden string %q in downstream binary %s", value, filepath.Base(path))
		}
	}
}

func assertSymbols(t *testing.T, root string, path string, expected ...string) {
	t.Helper()
	nm := commandOutput(t, root, "go", "tool", "nm", path)
	for _, symbol := range expected {
		if !strings.Contains(nm, symbol) {
			t.Errorf("expected symbol %q in stable binary %s", symbol, filepath.Base(path))
		}
	}
}

func assertNoSymbols(t *testing.T, root string, path string, forbidden ...string) {
	t.Helper()
	nm := commandOutput(t, root, "go", "tool", "nm", path)
	for _, symbol := range forbidden {
		if strings.Contains(nm, symbol) {
			t.Errorf("forbidden symbol fragment %q in downstream binary %s", symbol, filepath.Base(path))
		}
	}
}

func TestStableBackendBaseline(t *testing.T) {
	root := repoRoot(t)
	head := strings.TrimSpace(commandOutput(t, root, "git", "rev-parse", "HEAD"))
	if head != stableCommit {
		t.Fatalf("backend baseline commit = %s, want %s", head, stableCommit)
	}

	paths := make([]string, 0, len(backendSeamHashes))
	for path := range backendSeamHashes {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		data, err := os.ReadFile(filepath.Join(root, path))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		got := hex.EncodeToString(sum[:])
		if got != backendSeamHashes[path] {
			t.Errorf("%s SHA-256 = %s, want %s", path, got, backendSeamHashes[path])
		}
	}
}

func TestStableOwnersContainForbiddenClosure(t *testing.T) {
	root := repoRoot(t)
	serverDeps := goDependencies(t, root, "./cmd/server")
	assertDependencies(
		t,
		serverDeps,
		"github.com/wavetermdev/waveterm/pkg/aiusechat",
		"github.com/wavetermdev/waveterm/pkg/buildercontroller",
		"github.com/wavetermdev/waveterm/pkg/remote",
		"github.com/wavetermdev/waveterm/pkg/telemetry",
		"github.com/wavetermdev/waveterm/pkg/wcloud",
		"github.com/wavetermdev/waveterm/tsunami/build",
	)

	wshDeps := goDependencies(t, root, "./cmd/wsh")
	assertDependencies(
		t,
		wshDeps,
		"github.com/wavetermdev/waveterm/cmd/wsh/cmd",
		"github.com/wavetermdev/waveterm/pkg/jobmanager",
		"github.com/wavetermdev/waveterm/pkg/remote",
		"github.com/wavetermdev/waveterm/pkg/telemetry/telemetrydata",
	)

	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("binary closure is frozen on the initial darwin-arm64 target")
	}
	wavesrv := buildBinary(t, root, "./cmd/server", "wavesrv")
	wsh := buildBinary(t, root, "./cmd/wsh", "wsh")
	for _, path := range []string{wavesrv, wsh} {
		file, err := macho.Open(path)
		if err != nil {
			t.Fatalf("open Mach-O %s: %v", path, err)
		}
		if file.Cpu != macho.CpuArm64 {
			t.Errorf("%s CPU = %s, want arm64", filepath.Base(path), file.Cpu)
		}
		file.Close()
	}

	assertBinaryStrings(
		t,
		wavesrv,
		"api.waveterm.dev",
		"ping.waveterm.dev",
		"cfapi.waveterm.dev",
		"api.openai.com",
		"openrouter.ai",
		"generativelanguage.googleapis.com",
	)
	assertSymbols(
		t,
		root,
		wavesrv,
		"pkg/wcloud.SendAllTelemetry",
		"pkg/wshrpc/wshserver.(*WshServer).WaveAIEnableTelemetryCommand",
		"pkg/buildercontroller.(*BuilderController).Start",
		"pkg/blockcontroller.(*TsunamiController).Start",
	)
	assertSymbols(
		t,
		root,
		wsh,
		"cmd/wsh/cmd.aiCmd",
		"cmd/wsh/cmd.debugSendTelemetryCmd",
		"pkg/jobmanager.(*JobManager).PrepareConnect",
	)
}

func TestFeatureClosure(t *testing.T) {
	root := repoRoot(t)
	var missing []string
	for _, path := range downstreamFiles {
		if _, err := os.Stat(filepath.Join(root, path)); err != nil {
			if os.IsNotExist(err) {
				missing = append(missing, path)
				continue
			}
			t.Fatal(err)
		}
	}
	if len(missing) > 0 {
		t.Fatalf(
			"RED: downstream closure does not exist; missing exact reviewed files:\n%s",
			strings.Join(missing, "\n"),
		)
	}

	for _, target := range []string{"./hyprlane/cmd/wavesrv", "./hyprlane/cmd/wsh"} {
		deps := goDependencies(t, root, target)
		assertNoDependencyPrefixes(
			t,
			deps,
			"github.com/wavetermdev/waveterm/cmd/server",
			"github.com/wavetermdev/waveterm/cmd/wsh/cmd",
			"github.com/wavetermdev/waveterm/pkg/aiusechat",
			"github.com/wavetermdev/waveterm/pkg/buildercontroller",
			"github.com/wavetermdev/waveterm/pkg/remote",
			"github.com/wavetermdev/waveterm/pkg/telemetry",
			"github.com/wavetermdev/waveterm/pkg/wcloud",
			"github.com/wavetermdev/waveterm/pkg/web",
			"github.com/wavetermdev/waveterm/pkg/wshrpc/wshserver",
			"github.com/wavetermdev/waveterm/tsunami",
		)
	}

	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("binary closure is frozen on the initial darwin-arm64 target")
	}
	wavesrv := buildBinary(t, root, "./hyprlane/cmd/wavesrv", "hyprlane-wavesrv")
	wsh := buildBinary(t, root, "./hyprlane/cmd/wsh", "hyprlane-wsh")
	for _, path := range []string{wavesrv, wsh} {
		assertNoBinaryStrings(
			t,
			path,
			"api.waveterm.dev",
			"ping.waveterm.dev",
			"cfapi.waveterm.dev",
			"api.openai.com",
			"openrouter.ai",
			"generativelanguage.googleapis.com",
		)
		assertNoSymbols(
			t,
			root,
			path,
			"cmd/server",
			"cmd/wsh/cmd",
			"pkg/aiusechat",
			"pkg/buildercontroller",
			"pkg/blockcontroller.(*TsunamiController)",
			"pkg/remote",
			"pkg/telemetry",
			"pkg/wcloud",
			"pkg/wshrpc/wshserver",
			"telemetryLoop",
			"diagnosticLoop",
		)
	}
}

type nativeMethodLocation struct {
	path        string
	line        int
	receiver    string
	fingerprint string
}

func formatNode(t *testing.T, fset *token.FileSet, node any) string {
	t.Helper()
	var output bytes.Buffer
	if err := format.Node(&output, fset, node); err != nil {
		t.Fatal(err)
	}
	return output.String()
}

func nativeMethodFingerprint(t *testing.T, fset *token.FileSet, fn *ast.FuncDecl) string {
	t.Helper()
	return formatNode(t, fset, fn.Type) + "\n" + formatNode(t, fset, fn.Body)
}

func nativeMethodReceiver(t *testing.T, fset *token.FileSet, fn *ast.FuncDecl) string {
	t.Helper()
	if fn.Recv == nil || len(fn.Recv.List) != 1 {
		return ""
	}
	return formatNode(t, fset, fn.Recv.List[0].Type)
}

func nativeServerMethods(t *testing.T, root string) map[string][]nativeMethodLocation {
	t.Helper()
	required := make(map[string]bool)
	for _, name := range requiredNativeTerminalMethods {
		required[name] = true
	}
	found := make(map[string][]nativeMethodLocation)
	fset := token.NewFileSet()
	err := filepath.WalkDir(filepath.Join(root, "pkg"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil || !required[fn.Name.Name] {
				continue
			}
			position := fset.Position(fn.Pos())
			found[fn.Name.Name] = append(found[fn.Name.Name], nativeMethodLocation{
				path:        filepath.ToSlash(rel),
				line:        position.Line,
				receiver:    nativeMethodReceiver(t, fset, fn),
				fingerprint: nativeMethodFingerprint(t, fset, fn),
			})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func stableNativeMethodFingerprints(t *testing.T, root string) map[string]string {
	t.Helper()
	source := commandOutput(
		t,
		root,
		"git",
		"show",
		stableCommit+":pkg/wshrpc/wshserver/wshserver.go",
	)
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "wshserver.go", source, 0)
	if err != nil {
		t.Fatal(err)
	}
	required := make(map[string]bool)
	for _, name := range requiredNativeTerminalMethods {
		required[name] = true
	}
	fingerprints := make(map[string]string)
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || !required[fn.Name.Name] {
			continue
		}
		fingerprints[fn.Name.Name] = nativeMethodFingerprint(t, fset, fn)
	}
	if len(fingerprints) != len(requiredNativeTerminalMethods) {
		t.Fatalf(
			"stable native method fingerprint count = %d, want %d",
			len(fingerprints),
			len(requiredNativeTerminalMethods),
		)
	}
	return fingerprints
}

func TestNativeWshReuseClosure(t *testing.T) {
	root := repoRoot(t)
	found := nativeServerMethods(t, root)
	expectedFingerprints := stableNativeMethodFingerprints(t, root)
	var problems []string
	for _, method := range requiredNativeTerminalMethods {
		locations := found[method]
		if len(locations) != 1 {
			problems = append(
				problems,
				fmt.Sprintf("%s has %d definitions, want exactly 1", method, len(locations)),
			)
			continue
		}
		location := locations[0]
		if !strings.HasPrefix(
			location.path,
			"pkg/wshrpc/wshserver/terminalserver/",
		) {
			problems = append(
				problems,
				fmt.Sprintf("%s remains in forbidden owner %s:%d", method, location.path, location.line),
			)
		}
		if location.receiver != "*Server" {
			problems = append(
				problems,
				fmt.Sprintf("%s receiver = %q, want *Server", method, location.receiver),
			)
		}
		if location.fingerprint != expectedFingerprints[method] {
			problems = append(
				problems,
				fmt.Sprintf("%s signature/body differs from the pinned native implementation", method),
			)
		}
	}
	if len(problems) == 0 {
		return
	}
	sort.Strings(problems)
	t.Fatalf(
		"RED: native terminal RPC reuse closure is not a single-source move into the reviewed terminalserver package:\n%s",
		strings.Join(problems, "\n"),
	)
}
