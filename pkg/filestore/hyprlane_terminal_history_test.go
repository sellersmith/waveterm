// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package filestore

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func withEmbeddedTerminalHistory(t *testing.T) {
	t.Helper()
	previous := embeddedTerminalHistoryEnabled
	embeddedTerminalHistoryEnabled = func() bool { return true }
	t.Cleanup(func() {
		embeddedTerminalHistoryEnabled = previous
	})
}

func makeEmbeddedTerminalFile(t *testing.T, ctx context.Context, zoneID string) {
	t.Helper()
	err := WFS.MakeFile(ctx, zoneID, terminalHistoryFileName, nil, wshrpc.FileOpts{
		Circular: true,
		MaxSize:  2 * 1024 * 1024,
	})
	if err != nil {
		t.Fatalf("creating embedded terminal history: %v", err)
	}
}

func TestRetainedTerminalHistoryStartHonorsBytesAndLines(t *testing.T) {
	tests := []struct {
		name      string
		data      string
		base      int64
		maxBytes  int
		maxLines  int
		wantStart int64
	}{
		{
			name:      "within both limits",
			data:      "one\ntwo\n",
			base:      41,
			maxBytes:  32,
			maxLines:  2,
			wantStart: 41,
		},
		{
			name:      "byte limit cuts one huge record",
			data:      "0123456789",
			base:      100,
			maxBytes:  6,
			maxLines:  5,
			wantStart: 104,
		},
		{
			name:      "line limit starts after oldest complete record",
			data:      "one\ntwo\nthree\npartial",
			base:      9,
			maxBytes:  128,
			maxLines:  2,
			wantStart: 13,
		},
		{
			name:      "stricter byte limit wins",
			data:      "one\ntwo\nthree\n",
			base:      7,
			maxBytes:  5,
			maxLines:  20,
			wantStart: 16,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := retainedTerminalHistoryStart(
				[]byte(test.data),
				test.base,
				test.maxBytes,
				test.maxLines,
			)
			if got != test.wantStart {
				t.Fatalf("start mismatch: got %d, want %d", got, test.wantStart)
			}
		})
	}
}

func TestEmbeddedTerminalHistoryCapsAcrossChunkBoundaries(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	withEmbeddedTerminalHistory(t)
	// The production limit is an exact multiple of the production part size.
	// Override the tiny generic filestore test part size for this integration test.
	partDataSize = DefaultPartDataSize

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	zoneID := uuid.NewString()
	makeEmbeddedTerminalFile(t, ctx, zoneID)

	file, err := WFS.Stat(ctx, zoneID, terminalHistoryFileName)
	if err != nil {
		t.Fatalf("statting embedded terminal history: %v", err)
	}
	if file.Opts.MaxSize != EmbeddedTerminalHistoryMaxBytes {
		t.Fatalf("max bytes mismatch: got %d, want %d", file.Opts.MaxSize, EmbeddedTerminalHistoryMaxBytes)
	}

	var all strings.Builder
	for index := 0; index < EmbeddedTerminalHistoryMaxLines+1; index++ {
		all.WriteString("line\n")
	}
	output := []byte(all.String())
	// Split inside a line to prove the limiter is stream/chunk independent.
	firstEnd := len(output) - len("ne\n")
	firstStart, firstEndOffset, err := WFS.AppendDataWithRange(
		ctx,
		zoneID,
		terminalHistoryFileName,
		output[:firstEnd],
	)
	if err != nil {
		t.Fatalf("appending first history chunk: %v", err)
	}
	if firstStart != 0 || firstEndOffset != int64(firstEnd) {
		t.Fatalf("first append range mismatch: got [%d,%d), want [0,%d)", firstStart, firstEndOffset, firstEnd)
	}
	secondStart, secondEnd, err := WFS.AppendDataWithRange(
		ctx,
		zoneID,
		terminalHistoryFileName,
		output[firstEnd:],
	)
	if err != nil {
		t.Fatalf("appending second history chunk: %v", err)
	}
	if secondStart != int64(firstEnd) || secondEnd != int64(len(output)) {
		t.Fatalf(
			"second append range mismatch: got [%d,%d), want [%d,%d)",
			secondStart,
			secondEnd,
			firstEnd,
			len(output),
		)
	}
	if _, err := WFS.FlushCache(ctx); err != nil {
		t.Fatalf("flushing capped terminal history: %v", err)
	}
	WFS.clearCache()

	offset, retained, err := WFS.ReadFile(ctx, zoneID, terminalHistoryFileName)
	if err != nil {
		t.Fatalf("reading capped terminal history: %v", err)
	}
	if offset != int64(len("line\n")) {
		t.Fatalf("line-capped offset mismatch: got %d, want %d", offset, len("line\n"))
	}
	if bytes.Count(retained, []byte("\n")) != EmbeddedTerminalHistoryMaxLines {
		t.Fatalf(
			"retained newline count mismatch: got %d, want %d",
			bytes.Count(retained, []byte("\n")),
			EmbeddedTerminalHistoryMaxLines,
		)
	}
	if err := WFS.AppendData(ctx, zoneID, terminalHistoryFileName, []byte("after-reload\n")); err != nil {
		t.Fatalf("appending after history cache reload: %v", err)
	}
	offset, retained, err = WFS.ReadFile(ctx, zoneID, terminalHistoryFileName)
	if err != nil {
		t.Fatalf("reading after history cache reload append: %v", err)
	}
	if offset != int64(2*len("line\n")) {
		t.Fatalf("reloaded line-capped offset mismatch: got %d, want %d", offset, 2*len("line\n"))
	}
	if bytes.Count(retained, []byte("\n")) != EmbeddedTerminalHistoryMaxLines {
		t.Fatalf("reloaded history exceeded line cap: %d", bytes.Count(retained, []byte("\n")))
	}
}

func TestEmbeddedTerminalHistoryKeepsExactSuffixOfHugeWrite(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	withEmbeddedTerminalHistory(t)
	partDataSize = DefaultPartDataSize

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	zoneID := uuid.NewString()
	makeEmbeddedTerminalFile(t, ctx, zoneID)

	prefix := bytes.Repeat([]byte("x"), 137)
	want := bytes.Repeat([]byte("y"), int(EmbeddedTerminalHistoryMaxBytes))
	input := append(prefix, want...)
	start, end, err := WFS.AppendDataWithRange(ctx, zoneID, terminalHistoryFileName, input)
	if err != nil {
		t.Fatalf("appending huge terminal write: %v", err)
	}
	if start != 0 || end != int64(len(input)) {
		t.Fatalf("huge append range mismatch: got [%d,%d), want [0,%d)", start, end, len(input))
	}

	offset, retained, err := WFS.ReadFile(ctx, zoneID, terminalHistoryFileName)
	if err != nil {
		t.Fatalf("reading huge terminal write: %v", err)
	}
	if offset != int64(len(prefix)) {
		t.Fatalf("byte-capped offset mismatch: got %d, want %d", offset, len(prefix))
	}
	if !bytes.Equal(retained, want) {
		t.Fatalf("huge terminal write did not retain the exact %d-byte suffix", len(want))
	}
}

func TestEmbeddedTerminalHistoryTruncateResetsLogicalOffset(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	withEmbeddedTerminalHistory(t)
	partDataSize = DefaultPartDataSize

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	zoneID := uuid.NewString()
	makeEmbeddedTerminalFile(t, ctx, zoneID)

	data := bytes.Repeat([]byte("line\n"), EmbeddedTerminalHistoryMaxLines+1)
	if err := WFS.AppendData(ctx, zoneID, terminalHistoryFileName, data); err != nil {
		t.Fatalf("appending history before truncate: %v", err)
	}
	if err := WFS.WriteFile(ctx, zoneID, terminalHistoryFileName, nil); err != nil {
		t.Fatalf("truncating terminal history: %v", err)
	}
	_, _, generation, err := WFS.AppendDataWithRangeAndGeneration(
		ctx,
		zoneID,
		terminalHistoryFileName,
		[]byte("fresh\n"),
	)
	if err != nil {
		t.Fatalf("appending history after truncate: %v", err)
	}
	if generation != 2 {
		t.Fatalf("terminal generation did not advance on truncate: %d", generation)
	}

	offset, retained, err := WFS.ReadFile(ctx, zoneID, terminalHistoryFileName)
	if err != nil {
		t.Fatalf("reading history after truncate: %v", err)
	}
	if offset != 0 || string(retained) != "fresh\n" {
		t.Fatalf("truncate did not reset history: offset=%d data=%q", offset, retained)
	}
}

func TestWriteFileAndMetaCommitsCacheAtomically(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	ctx := context.Background()
	zoneID := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneID, "cache:term:full", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("creating terminal cache: %v", err)
	}
	meta := wshrpc.FileMeta{"ptyoffset": int64(42), "generation": int64(3)}
	if err := WFS.WriteFileAndMeta(ctx, zoneID, "cache:term:full", []byte("state"), meta); err != nil {
		t.Fatalf("writing atomic terminal cache: %v", err)
	}
	WFS.clearCache()
	file, err := WFS.Stat(ctx, zoneID, "cache:term:full")
	if err != nil {
		t.Fatalf("statting atomic terminal cache: %v", err)
	}
	_, data, err := WFS.ReadFile(ctx, zoneID, "cache:term:full")
	if err != nil {
		t.Fatalf("reading atomic terminal cache: %v", err)
	}
	if string(data) != "state" || file.Meta["ptyoffset"].(float64) != 42 || file.Meta["generation"].(float64) != 3 {
		t.Fatalf("cache bytes/meta mismatch after reload: data=%q meta=%v", data, file.Meta)
	}
}

func TestBoundEmbeddedTerminalCacheRejectsUnsafeByteSuffix(t *testing.T) {
	withEmbeddedTerminalHistory(t)
	oversized := bytes.Repeat([]byte("x"), int(EmbeddedTerminalCacheMaxBytes)+1)
	state, offset := BoundEmbeddedTerminalCache(oversized, 99)
	if len(state) != 0 || offset != 0 {
		t.Fatalf("oversized cache was not reset safely: bytes=%d offset=%d", len(state), offset)
	}

	exact := bytes.Repeat([]byte("x"), int(EmbeddedTerminalCacheMaxBytes))
	state, offset = BoundEmbeddedTerminalCache(exact, 99)
	if !bytes.Equal(state, exact) || offset != 99 {
		t.Fatalf("exact-size cache changed: bytes=%d offset=%d", len(state), offset)
	}
	state, offset = BoundEmbeddedTerminalCache([]byte("valid"), -1)
	if len(state) != 0 || offset != 0 {
		t.Fatalf("negative cache offset was not reset: bytes=%d offset=%d", len(state), offset)
	}
}

func TestExistingTerminalHistoryMigratesIdempotently(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	partDataSize = DefaultPartDataSize
	previous := embeddedTerminalHistoryEnabled
	embeddedTerminalHistoryEnabled = func() bool { return false }
	defer func() { embeddedTerminalHistoryEnabled = previous }()

	ctx := context.Background()
	zoneID := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneID, terminalHistoryFileName, nil, wshrpc.FileOpts{
		Circular: true,
		MaxSize:  2 * 1024 * 1024,
	}); err != nil {
		t.Fatalf("creating legacy terminal history: %v", err)
	}
	legacyData := bytes.Repeat([]byte("legacy-line\n"), EmbeddedTerminalHistoryMaxLines+100)
	if err := WFS.AppendData(ctx, zoneID, terminalHistoryFileName, legacyData); err != nil {
		t.Fatalf("writing legacy terminal history: %v", err)
	}

	embeddedTerminalHistoryEnabled = func() bool { return true }
	err := WFS.MakeFile(ctx, zoneID, terminalHistoryFileName, nil, wshrpc.FileOpts{
		Circular: true,
		MaxSize:  2 * 1024 * 1024,
	})
	if !errors.Is(err, fs.ErrExist) {
		t.Fatalf("migrating existing terminal history returned %v", err)
	}
	file, err := WFS.Stat(ctx, zoneID, terminalHistoryFileName)
	if err != nil {
		t.Fatalf("statting migrated history: %v", err)
	}
	if file.Opts.MaxSize != EmbeddedTerminalHistoryMaxBytes {
		t.Fatalf("migrated byte cap mismatch: %d", file.Opts.MaxSize)
	}
	if generation, ok := TerminalHistoryGeneration(file); !ok || generation != 1 {
		t.Fatalf("migrated generation mismatch: %d, %v", generation, ok)
	}
	_, retained, err := WFS.ReadFile(ctx, zoneID, terminalHistoryFileName)
	if err != nil {
		t.Fatalf("reading migrated history: %v", err)
	}
	if len(retained) > int(EmbeddedTerminalHistoryMaxBytes) || bytes.Count(retained, []byte("\n")) != EmbeddedTerminalHistoryMaxLines {
		t.Fatalf("migrated bounds mismatch: bytes=%d lines=%d", len(retained), bytes.Count(retained, []byte("\n")))
	}
}

func TestTerminalSnapshotMetadataAndBodyStayAtomicDuringAppends(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	withEmbeddedTerminalHistory(t)
	partDataSize = DefaultPartDataSize
	ctx := context.Background()
	zoneID := uuid.NewString()
	makeEmbeddedTerminalFile(t, ctx, zoneID)

	done := make(chan error, 1)
	go func() {
		for index := 0; index < 200; index++ {
			if err := WFS.AppendData(ctx, zoneID, terminalHistoryFileName, bytes.Repeat([]byte{'x'}, 4096)); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for index := 0; index < 200; index++ {
		file, offset, data, err := WFS.ReadFileSnapshot(ctx, zoneID, terminalHistoryFileName, 0)
		if err != nil {
			t.Fatalf("reading atomic snapshot: %v", err)
		}
		if offset+int64(len(data)) != file.Size {
			t.Fatalf("mixed snapshot: offset=%d bytes=%d size=%d", offset, len(data), file.Size)
		}
	}
	if err := <-done; err != nil {
		t.Fatalf("concurrent snapshot writer: %v", err)
	}
}

func TestTerminalCacheSnapshotMetadataAndBodyStayAtomicDuringReplacement(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	ctx := context.Background()
	zoneID := uuid.NewString()
	name := "cache:term:full"
	if err := WFS.MakeFile(ctx, zoneID, name, nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("creating cache snapshot file: %v", err)
	}
	if err := WFS.WriteFileAndMeta(ctx, zoneID, name, []byte("0"), wshrpc.FileMeta{"revision": 0}); err != nil {
		t.Fatalf("seeding cache snapshot file: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		for revision := 1; revision <= 200; revision++ {
			value := byte('0' + revision%10)
			if err := WFS.WriteFileAndMeta(
				ctx,
				zoneID,
				name,
				bytes.Repeat([]byte{value}, 4096),
				wshrpc.FileMeta{"revision": revision % 10},
			); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for index := 0; index < 200; index++ {
		file, _, data, err := WFS.ReadFileSnapshot(ctx, zoneID, name, 0)
		if err != nil {
			t.Fatalf("reading atomic cache snapshot: %v", err)
		}
		if len(data) == 0 {
			t.Fatal("atomic cache snapshot was empty")
		}
		revision, ok := metadataInt64(file.Meta["revision"])
		if !ok || data[0] != byte('0'+revision) || !bytes.Equal(data, bytes.Repeat(data[:1], len(data))) {
			t.Fatalf("mixed cache snapshot: revision=%v bytes=%q", file.Meta["revision"], data[:1])
		}
	}
	if err := <-done; err != nil {
		t.Fatalf("concurrent cache snapshot writer: %v", err)
	}
}
