// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const standaloneRendererRPCPolicyHelper = "HYPRLANE_TEST_STANDALONE_RENDERER_RPC_POLICY"
const rendererTabRoute = "tab:d759aed2-8437-48bf-bea5-f517d4a7d03c"
const rendererOwnedBlockRoute = "feblock:b3f301dc-7a44-4a8f-b792-f606ca7a1121"
const rendererOwnedSubBlockRoute = "feblock:98386a83-f766-4f31-90c4-b78f1b33208c"
const rendererOwnedParentBlockID = "28437688-d524-4295-860f-202826b18814"

func missingRendererBlockParent(
	context.Context,
	string,
) (string, error) {
	return "", fmt.Errorf("block not found")
}

func rendererRPCCommand(command string) map[string]any {
	return map[string]any{
		"wscommand": "rpc",
		"message": map[string]any{
			"command": command,
			"reqid":   "renderer-request",
			"route":   "conn:local",
		},
	}
}

func rendererRouteControlCommand(
	command string,
	route string,
	source string,
	data any,
) map[string]any {
	return map[string]any{
		"wscommand": "rpc",
		"message": map[string]any{
			"command": command,
			"reqid":   "renderer-route-request",
			"route":   route,
			"source":  source,
			"data":    data,
		},
	}
}

func assertRendererRouteControlPolicy(
	t *testing.T,
	message map[string]any,
	lookupBlockParent embeddedBlockParentLookup,
	wantForward bool,
) {
	t.Helper()
	outputCh := make(chan any, 1)
	rpcInputCh := make(chan baseds.RpcInputChType, 1)
	processWSCommand(
		context.Background(),
		message,
		outputCh,
		rpcInputCh,
		rendererTabRoute,
		lookupBlockParent,
	)

	select {
	case forwarded := <-rpcInputCh:
		if !wantForward {
			t.Fatalf("route control reached trusted WSH router: %s", forwarded.MsgBytes)
		}
	default:
		if wantForward {
			t.Fatal("allowed route control was not forwarded")
		}
	}
	select {
	case output := <-outputCh:
		if wantForward {
			t.Fatalf("allowed route control returned an ingress error: %v", output)
		}
		eventMap, ok := output.(map[string]any)
		if !ok {
			t.Fatalf("route denial returned unexpected output: %T", output)
		}
		if eventMap["eventtype"] != "rpc" {
			t.Fatalf("route denial returned a non-RPC envelope: %v", eventMap)
		}
		rpcData, ok := eventMap["data"].(map[string]any)
		if !ok {
			t.Fatalf("route denial returned invalid RPC data: %T", eventMap["data"])
		}
		if rpcData["resid"] != "renderer-route-request" {
			t.Fatalf("route denial response id = %v", rpcData["resid"])
		}
		errorMessage, _ := rpcData["error"].(string)
		if !strings.Contains(errorMessage, "route announcement denied by host policy") {
			t.Fatalf("route denial error = %q", errorMessage)
		}
	default:
		if !wantForward {
			t.Fatal("denied route control did not return an ingress error")
		}
	}
}

func assertRendererRPCPolicy(
	t *testing.T,
	command string,
	wantForward bool,
) {
	t.Helper()
	outputCh := make(chan any, 1)
	rpcInputCh := make(chan baseds.RpcInputChType, 1)

	processWSCommand(
		context.Background(),
		rendererRPCCommand(command),
		outputCh,
		rpcInputCh,
		rendererTabRoute,
		missingRendererBlockParent,
	)

	select {
	case forwarded := <-rpcInputCh:
		if !wantForward {
			t.Fatalf("command %q reached the trusted WSH router: %s", command, forwarded.MsgBytes)
		}
	default:
		if wantForward {
			t.Fatalf("command %q was not forwarded", command)
		}
	}

	select {
	case output := <-outputCh:
		if wantForward {
			t.Fatalf("allowed command %q returned an ingress error: %v", command, output)
		}
		eventMap, ok := output.(map[string]any)
		if !ok {
			t.Fatalf("denied command %q returned unexpected output: %T", command, output)
		}
		if eventMap["eventtype"] != "rpc" {
			t.Fatalf("denied command %q returned a non-RPC envelope: %v", command, eventMap)
		}
		rpcData, ok := eventMap["data"].(map[string]any)
		if !ok {
			t.Fatalf("denied command %q returned invalid RPC data: %T", command, eventMap["data"])
		}
		if rpcData["resid"] != "renderer-request" {
			t.Fatalf("denied command %q response id = %v", command, rpcData["resid"])
		}
		errorMessage, _ := rpcData["error"].(string)
		if !strings.Contains(errorMessage, fmt.Sprintf("command %q denied by host policy", command)) {
			t.Fatalf("denied command %q error = %q", command, errorMessage)
		}
	default:
		if !wantForward {
			t.Fatalf("denied command %q did not return an ingress error", command)
		}
	}
}

func TestEmbeddedRendererRPCIngressEnforcesCommandPolicy(t *testing.T) {
	initializeEmbeddedPolicy(t)

	for _, command := range []string{"remotestartjob", "startjob"} {
		t.Run("denies_"+command, func(t *testing.T) {
			assertRendererRPCPolicy(t, command, false)
		})
	}
	for _, command := range []string{"controllerinput"} {
		t.Run("allows_"+command, func(t *testing.T) {
			assertRendererRPCPolicy(t, command, true)
		})
	}
}

func TestEmbeddedRendererLocalOnlyCommandsRejectRemoteTargets(t *testing.T) {
	initializeEmbeddedPolicy(t)
	tests := []struct {
		name    string
		message *wshutil.RpcMessage
		wantErr bool
	}{
		{
			name: "allows local file connection initialization",
			message: &wshutil.RpcMessage{
				Command: "connensure",
				Data:    map[string]any{"connname": ""},
			},
		},
		{
			name: "denies remote file connection initialization",
			message: &wshutil.RpcMessage{
				Command: "connensure",
				Data:    map[string]any{"connname": "ssh://example"},
			},
			wantErr: true,
		},
		{
			name: "allows local process inspection",
			message: &wshutil.RpcMessage{
				Command: "remoteprocesslist",
				Route:   "conn:local",
			},
		},
		{
			name: "denies remote process inspection",
			message: &wshutil.RpcMessage{
				Command: "remoteprocesslist",
				Route:   "conn:ssh://example",
			},
			wantErr: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateEmbeddedRendererLocalCommand(test.message)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateEmbeddedRendererLocalCommand() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestEmbeddedRendererRPCIngressRejectsProtectedRouteAnnouncement(t *testing.T) {
	initializeEmbeddedPolicy(t)
	protectedRoutes := []string{
		"wavesrv",
		"electron",
		"conn:local",
		"controller:b3f301dc-7a44-4a8f-b792-f606ca7a1121",
		"proc:b3f301dc-7a44-4a8f-b792-f606ca7a1121",
		"job:b3f301dc-7a44-4a8f-b792-f606ca7a1121",
		"builder:b3f301dc-7a44-4a8f-b792-f606ca7a1121",
		"bare:b3f301dc-7a44-4a8f-b792-f606ca7a1121",
		"tab:1e512f34-5bf8-4c53-84fe-c8f7bb5543a6",
	}
	for _, command := range []string{"routeannounce", "routeunannounce"} {
		for _, protectedRoute := range protectedRoutes {
			t.Run(command+"_"+strings.ReplaceAll(protectedRoute, ":", "_"), func(t *testing.T) {
				assertRendererRouteControlPolicy(
					t,
					rendererRouteControlCommand(
						command,
						wshutil.ControlRoute,
						protectedRoute,
						protectedRoute,
					),
					missingRendererBlockParent,
					false,
				)
			})
		}
	}
}

func TestEmbeddedRendererRouteControlAllowsExactStableTab(t *testing.T) {
	initializeEmbeddedPolicy(t)
	for _, command := range []string{"routeannounce", "routeunannounce"} {
		t.Run(command, func(t *testing.T) {
			assertRendererRouteControlPolicy(
				t,
				rendererRouteControlCommand(
					command,
					wshutil.ControlRoute,
					rendererTabRoute,
					rendererTabRoute,
				),
				missingRendererBlockParent,
				true,
			)
		})
	}
}

func TestEmbeddedRendererRouteControlRequiresSourceDataMatch(t *testing.T) {
	initializeEmbeddedPolicy(t)
	rpcMessage := &wshutil.RpcMessage{
		Command: "routeannounce",
		Route:   wshutil.ControlRoute,
		Source:  rendererTabRoute,
		Data:    "tab:00000000-0000-0000-0000-000000000000",
	}

	if err := validateEmbeddedRendererRouteControl(
		context.Background(),
		rpcMessage,
		rendererTabRoute,
		missingRendererBlockParent,
	); err == nil {
		t.Fatal("route control accepted mismatched source and data")
	}
}

func TestEmbeddedRendererRouteControlRequiresExactControlRoute(t *testing.T) {
	initializeEmbeddedPolicy(t)
	assertRendererRouteControlPolicy(
		t,
		rendererRouteControlCommand(
			"routeannounce",
			wshutil.ControlRootRoute,
			rendererTabRoute,
			rendererTabRoute,
		),
		missingRendererBlockParent,
		false,
	)
}

func TestEmbeddedRendererRouteControlAllowsOwnedFrontendBlock(t *testing.T) {
	initializeEmbeddedPolicy(t)
	lookupParent := func(_ context.Context, blockID string) (string, error) {
		if blockID != strings.TrimPrefix(
			rendererOwnedBlockRoute,
			wshutil.RoutePrefix_FeBlock,
		) {
			return "", fmt.Errorf("block not found")
		}
		return rendererTabRoute, nil
	}
	for _, command := range []string{"routeannounce", "routeunannounce"} {
		t.Run(command, func(t *testing.T) {
			assertRendererRouteControlPolicy(
				t,
				rendererRouteControlCommand(
					command,
					wshutil.ControlRoute,
					rendererOwnedBlockRoute,
					rendererOwnedBlockRoute,
				),
				lookupParent,
				true,
			)
		})
	}
}

func TestEmbeddedRendererRouteControlAllowsOwnedNestedFrontendBlock(t *testing.T) {
	initializeEmbeddedPolicy(t)
	rpcMessage := &wshutil.RpcMessage{
		Command: "routeannounce",
		Route:   wshutil.ControlRoute,
		Source:  rendererOwnedSubBlockRoute,
		Data:    rendererOwnedSubBlockRoute,
	}
	lookupParent := func(_ context.Context, blockID string) (string, error) {
		switch blockID {
		case strings.TrimPrefix(
			rendererOwnedSubBlockRoute,
			wshutil.RoutePrefix_FeBlock,
		):
			return waveobj.MakeORef(
				waveobj.OType_Block,
				rendererOwnedParentBlockID,
			).String(), nil
		case rendererOwnedParentBlockID:
			return rendererTabRoute, nil
		default:
			return "", fmt.Errorf("block not found")
		}
	}

	if err := validateEmbeddedRendererRouteControl(
		context.Background(),
		rpcMessage,
		rendererTabRoute,
		lookupParent,
	); err != nil {
		t.Fatalf("owned nested frontend block route denied: %v", err)
	}
}

func TestEmbeddedRendererRouteControlRejectsCrossTabFrontendBlock(t *testing.T) {
	initializeEmbeddedPolicy(t)
	const otherTabRoute = "tab:1e512f34-5bf8-4c53-84fe-c8f7bb5543a6"
	lookupParent := func(_ context.Context, blockID string) (string, error) {
		if blockID != strings.TrimPrefix(
			rendererOwnedBlockRoute,
			wshutil.RoutePrefix_FeBlock,
		) {
			return "", fmt.Errorf("block not found")
		}
		return otherTabRoute, nil
	}
	for _, command := range []string{"routeannounce", "routeunannounce"} {
		t.Run(command, func(t *testing.T) {
			assertRendererRouteControlPolicy(
				t,
				rendererRouteControlCommand(
					command,
					wshutil.ControlRoute,
					rendererOwnedBlockRoute,
					rendererOwnedBlockRoute,
				),
				lookupParent,
				false,
			)
		})
	}
}

func TestStandaloneRendererRPCIngressPreservesWaveCommands(t *testing.T) {
	if os.Getenv(standaloneRendererRPCPolicyHelper) == "1" {
		assertRendererRPCPolicy(t, "remotestartjob", true)
		assertRendererRouteControlPolicy(
			t,
			rendererRouteControlCommand(
				"routeannounce",
				wshutil.ControlRoute,
				"conn:local",
				"conn:local",
			),
			missingRendererBlockParent,
			true,
		)
		return
	}

	command := exec.Command(os.Args[0], "-test.run=^TestStandaloneRendererRPCIngressPreservesWaveCommands$")
	command.Env = []string{standaloneRendererRPCPolicyHelper + "=1"}
	for _, variable := range os.Environ() {
		if strings.HasPrefix(variable, "HYPRLANE_WAVE_") ||
			strings.HasPrefix(variable, standaloneRendererRPCPolicyHelper+"=") {
			continue
		}
		command.Env = append(command.Env, variable)
	}
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("standalone ingress helper failed: %v\n%s", err, output.String())
	}
}
