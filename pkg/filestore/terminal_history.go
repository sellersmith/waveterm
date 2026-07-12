// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package filestore

import (
	"bytes"
	"context"
	"encoding/json"
	"math"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	EmbeddedTerminalHistoryMaxBytes int64 = 256 * 1024
	EmbeddedTerminalHistoryMaxLines       = 5000

	terminalHistoryFileName       = "term"
	terminalHistoryLimitMetaKey   = "hyprlane:history-max-lines"
	terminalHistoryStartMetaKey   = "hyprlane:history-start"
	terminalHistoryGenerationKey  = "hyprlane:history-generation"
	EmbeddedTerminalCacheMaxBytes = EmbeddedTerminalHistoryMaxBytes
)

type terminalHistoryCache struct {
	newlineEnds []int64
}

// Overridable only by package tests. Production resolves the process-wide,
// immutable bootstrap policy cached before the file store starts.
var embeddedTerminalHistoryEnabled = policy.IsEmbedded

func configureEmbeddedTerminalHistory(
	name string,
	meta wshrpc.FileMeta,
	opts wshrpc.FileOpts,
) (wshrpc.FileMeta, wshrpc.FileOpts) {
	if !embeddedTerminalHistoryEnabled() || name != terminalHistoryFileName || !opts.Circular {
		return meta, opts
	}
	meta = copyMeta(meta)
	meta[terminalHistoryLimitMetaKey] = EmbeddedTerminalHistoryMaxLines
	meta[terminalHistoryStartMetaKey] = int64(0)
	meta[terminalHistoryGenerationKey] = int64(1)
	opts.MaxSize = EmbeddedTerminalHistoryMaxBytes
	return meta, opts
}

func TerminalHistoryGeneration(file *WaveFile) (int64, bool) {
	if file == nil || !embeddedTerminalHistoryEnabled() || file.Name != terminalHistoryFileName {
		return 0, false
	}
	generation, ok := metadataInt64(file.Meta[terminalHistoryGenerationKey])
	return generation, ok && generation > 0
}

func advanceTerminalHistoryGeneration(file *WaveFile) {
	if _, ok := terminalHistoryLineLimit(file); !ok {
		return
	}
	generation, ok := TerminalHistoryGeneration(file)
	if !ok {
		generation = 0
	}
	file.Meta[terminalHistoryGenerationKey] = generation + 1
}

func ensureEmbeddedTerminalHistory(ctx context.Context, entry *CacheEntry) error {
	file := entry.File
	if file == nil || !embeddedTerminalHistoryEnabled() || file.Name != terminalHistoryFileName || !file.Opts.Circular {
		return nil
	}
	_, hasLines := terminalHistoryLineLimit(file)
	_, hasGeneration := TerminalHistoryGeneration(file)
	if hasLines && hasGeneration && file.Opts.MaxSize == EmbeddedTerminalHistoryMaxBytes {
		return nil
	}
	oldStart := file.DataStartIdx()
	_, oldData, err := entry.readAt(ctx, oldStart, file.Size-oldStart, false)
	if err != nil {
		return err
	}
	newStart := retainedTerminalHistoryStart(
		oldData,
		oldStart,
		int(EmbeddedTerminalHistoryMaxBytes),
		EmbeddedTerminalHistoryMaxLines,
	)
	retained := oldData[newStart-oldStart:]
	oldSize := file.Size
	file.Opts.MaxSize = EmbeddedTerminalHistoryMaxBytes
	if file.Meta == nil {
		file.Meta = make(wshrpc.FileMeta)
	}
	file.Meta[terminalHistoryLimitMetaKey] = EmbeddedTerminalHistoryMaxLines
	file.Meta[terminalHistoryStartMetaKey] = newStart
	file.Meta[terminalHistoryGenerationKey] = int64(1)
	entry.DataEntries = make(map[int]*DataCacheEntry)
	file.Size = newStart
	entry.writeAt(newStart, retained, false)
	file.Size = oldSize
	entry.TermHistory = &terminalHistoryCache{
		newlineEnds: terminalNewlineEnds(retained, newStart, newStart),
	}
	return entry.flushToDB(ctx, true)
}

func terminalHistoryLineLimit(file *WaveFile) (int, bool) {
	if file == nil || !embeddedTerminalHistoryEnabled() || file.Name != terminalHistoryFileName || !file.Opts.Circular {
		return 0, false
	}
	limit, ok := metadataInt64(file.Meta[terminalHistoryLimitMetaKey])
	if !ok || limit <= 0 || limit > math.MaxInt {
		return 0, false
	}
	return int(limit), true
}

func terminalHistoryLogicalStart(file *WaveFile) int64 {
	if _, ok := terminalHistoryLineLimit(file); !ok {
		return 0
	}
	start, ok := metadataInt64(file.Meta[terminalHistoryStartMetaKey])
	if !ok || start < 0 || start > file.Size {
		return 0
	}
	return start
}

func metadataInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case float64:
		if math.Trunc(typed) != typed || typed < math.MinInt64 || typed > math.MaxInt64 {
			return 0, false
		}
		return int64(typed), true
	case json.Number:
		value, err := typed.Int64()
		return value, err == nil
	default:
		return 0, false
	}
}

func retainedTerminalHistoryStart(
	data []byte,
	baseOffset int64,
	maxBytes int,
	maxLines int,
) int64 {
	startIndex := 0
	if maxBytes >= 0 && len(data) > maxBytes {
		startIndex = len(data) - maxBytes
	}
	if maxLines < 0 {
		return baseOffset + int64(startIndex)
	}
	retained := data[startIndex:]
	newlineCount := bytes.Count(retained, []byte{'\n'})
	linesToDrop := newlineCount - maxLines
	for linesToDrop > 0 {
		relativeNewline := bytes.IndexByte(data[startIndex:], '\n')
		if relativeNewline < 0 {
			break
		}
		startIndex += relativeNewline + 1
		linesToDrop--
	}
	return baseOffset + int64(startIndex)
}

func resetTerminalHistoryStart(file *WaveFile) {
	if _, ok := terminalHistoryLineLimit(file); !ok {
		return
	}
	file.Meta[terminalHistoryStartMetaKey] = int64(0)
}

func updateTerminalHistoryStart(ctx context.Context, entry *CacheEntry) error {
	lineLimit, ok := terminalHistoryLineLimit(entry.File)
	if !ok {
		return nil
	}
	currentStart := entry.File.DataStartIdx()
	_, retained, err := entry.readAt(
		ctx,
		currentStart,
		entry.File.Size-currentStart,
		false,
	)
	if err != nil {
		return err
	}
	newStart := retainedTerminalHistoryStart(
		retained,
		currentStart,
		int(entry.File.Opts.MaxSize),
		lineLimit,
	)
	entry.File.Meta[terminalHistoryStartMetaKey] = newStart
	entry.TermHistory = &terminalHistoryCache{
		newlineEnds: terminalNewlineEnds(retained, currentStart, newStart),
	}
	return nil
}

func terminalNewlineEnds(data []byte, baseOffset int64, afterOffset int64) []int64 {
	newlineEnds := make([]int64, 0, bytes.Count(data, []byte{'\n'}))
	for index, value := range data {
		if value != '\n' {
			continue
		}
		endOffset := baseOffset + int64(index) + 1
		if endOffset > afterOffset {
			newlineEnds = append(newlineEnds, endOffset)
		}
	}
	return newlineEnds
}

func initializeTerminalHistoryCache(ctx context.Context, entry *CacheEntry) error {
	if entry.TermHistory != nil {
		return nil
	}
	if _, ok := terminalHistoryLineLimit(entry.File); !ok {
		return nil
	}
	currentStart := entry.File.DataStartIdx()
	_, retained, err := entry.readAt(
		ctx,
		currentStart,
		entry.File.Size-currentStart,
		false,
	)
	if err != nil {
		return err
	}
	entry.TermHistory = &terminalHistoryCache{
		newlineEnds: terminalNewlineEnds(retained, currentStart, currentStart),
	}
	return nil
}

func updateTerminalHistoryAfterAppend(entry *CacheEntry, data []byte, appendStart int64) {
	lineLimit, ok := terminalHistoryLineLimit(entry.File)
	if !ok || entry.TermHistory == nil {
		return
	}
	physicalStart := int64(0)
	if entry.File.Size > entry.File.Opts.MaxSize {
		physicalStart = entry.File.Size - entry.File.Opts.MaxSize
	}
	logicalStart := terminalHistoryLogicalStart(entry.File)
	if physicalStart > logicalStart {
		logicalStart = physicalStart
	}

	newlineEnds := entry.TermHistory.newlineEnds
	firstRetained := 0
	for firstRetained < len(newlineEnds) && newlineEnds[firstRetained] <= logicalStart {
		firstRetained++
	}
	newlineEnds = newlineEnds[firstRetained:]
	for index, value := range data {
		if value != '\n' {
			continue
		}
		endOffset := appendStart + int64(index) + 1
		if endOffset <= logicalStart {
			continue
		}
		newlineEnds = append(newlineEnds, endOffset)
		if len(newlineEnds) > lineLimit+1 {
			newlineEnds = newlineEnds[len(newlineEnds)-(lineLimit+1):]
		}
	}
	if len(newlineEnds) > lineLimit {
		logicalStart = newlineEnds[len(newlineEnds)-lineLimit-1]
		newlineEnds = newlineEnds[len(newlineEnds)-lineLimit:]
	}
	entry.File.Meta[terminalHistoryStartMetaKey] = logicalStart
	entry.TermHistory.newlineEnds = newlineEnds
}

func BoundEmbeddedTerminalCache(state []byte, ptyOffset int64) ([]byte, int64) {
	if !embeddedTerminalHistoryEnabled() {
		return state, ptyOffset
	}
	if ptyOffset >= 0 && len(state) <= int(EmbeddedTerminalCacheMaxBytes) {
		return state, ptyOffset
	}
	// An arbitrary byte suffix may begin inside an escape sequence and corrupt
	// xterm state. Empty state with offset zero is safe: the renderer falls back
	// to the bounded raw terminal history instead.
	return nil, 0
}
