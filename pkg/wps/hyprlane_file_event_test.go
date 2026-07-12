// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package wps

import (
	"encoding/json"
	"testing"
)

func offsetPointer(value int64) *int64 {
	return &value
}

func TestWSFileEventDataAppendOffsetsAreOptionalAndPreserveZero(t *testing.T) {
	event := WSFileEventData{
		ZoneId:      "zone",
		FileName:    "term",
		FileOp:      FileOp_Append,
		Data64:      "YQ==",
		StartOffset: offsetPointer(0),
		EndOffset:   offsetPointer(1),
		Generation:  offsetPointer(7),
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshalling offset append: %v", err)
	}
	if string(encoded) != `{"zoneid":"zone","filename":"term","fileop":"append","data64":"YQ==","startoffset":0,"endoffset":1,"generation":7}` {
		t.Fatalf("unexpected offset append JSON: %s", encoded)
	}

	var legacy WSFileEventData
	if err := json.Unmarshal(
		[]byte(`{"zoneid":"zone","filename":"term","fileop":"append","data64":"YQ=="}`),
		&legacy,
	); err != nil {
		t.Fatalf("unmarshalling legacy append: %v", err)
	}
	if legacy.StartOffset != nil || legacy.EndOffset != nil || legacy.Generation != nil {
		t.Fatalf("legacy append unexpectedly gained offsets: %+v", legacy)
	}
}
