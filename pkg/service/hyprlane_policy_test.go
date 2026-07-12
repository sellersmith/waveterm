// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package service

import (
	"context"
	"strings"
	"testing"
)

type policyProbeService struct {
	called bool
}

func (service *policyProbeService) Mutate() string {
	service.called = true
	return "called"
}

func TestServicePolicyRejectsBeforeDispatch(t *testing.T) {
	probe := &policyProbeService{}
	oldProbe, hadProbe := ServiceMap["policyprobe"]
	oldPolicy := serviceCallAllowed
	ServiceMap["policyprobe"] = probe
	serviceCallAllowed = func(string, string) bool { return false }
	t.Cleanup(func() {
		serviceCallAllowed = oldPolicy
		if hadProbe {
			ServiceMap["policyprobe"] = oldProbe
		} else {
			delete(ServiceMap, "policyprobe")
		}
	})

	result := CallService(context.Background(), WebCallType{
		Service: "policyprobe",
		Method:  "Mutate",
	})
	if result.Error == "" || !strings.Contains(result.Error, "host policy") {
		t.Fatalf("policy rejection = %#v", result)
	}
	if probe.called {
		t.Fatal("denied service method executed")
	}
}
