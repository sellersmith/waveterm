// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    EmbeddedTerminalHistoryMaxBytes,
    EmbeddedTerminalHistoryMaxLines,
    HiddenTerminalReplayCoalescer,
    boundEmbeddedScrollback,
    drainTerminalAppendQueue,
    readEmbeddedSurfaceActivity,
    reconcileTerminalAppend,
    serializeBoundedTerminalState,
    subscribeEmbeddedSurfaceActivity,
    terminalGenerationChanged,
    type TerminalAppend,
} from "./terminal-replay";

function bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

describe("reconcileTerminalAppend", () => {
    it("detects a new terminal generation before comparing reset offsets", () => {
        expect(terminalGenerationChanged(7, 8)).toBe(true);
        expect(terminalGenerationChanged(7, 7)).toBe(false);
        expect(terminalGenerationChanged(null, 8)).toBe(false);
    });

    it("drops an append already covered by the HTTP replay snapshot", () => {
        expect(
            reconcileTerminalAppend(12, {
                data: bytes("cdef"),
                startOffset: 8,
                endOffset: 12,
            })
        ).toEqual({ kind: "discard" });
    });

    it("writes only the unseen suffix of an overlapping append", () => {
        const decision = reconcileTerminalAppend(10, {
            data: bytes("abcdefgh"),
            startOffset: 4,
            endOffset: 12,
        });
        expect(decision.kind).toBe("write");
        if (decision.kind !== "write") return;
        expect(new TextDecoder().decode(decision.data)).toBe("gh");
        expect(decision.endOffset).toBe(12);
    });

    it("requests a raw-tail resync when an append exposes a gap", () => {
        expect(
            reconcileTerminalAppend(10, {
                data: bytes("later"),
                startOffset: 15,
                endOffset: 20,
            })
        ).toEqual({ kind: "resync" });
    });

    it("requests a resync for malformed offset metadata", () => {
        expect(
            reconcileTerminalAppend(10, {
                data: bytes("bad"),
                startOffset: 10,
                endOffset: 99,
            })
        ).toEqual({ kind: "resync" });
    });

    it("preserves legacy Wave append behavior when offsets are absent", () => {
        const data = bytes("legacy");
        expect(reconcileTerminalAppend(10, { data })).toEqual({
            kind: "write",
            data,
            endOffset: null,
        });
    });
});

describe("drainTerminalAppendQueue", () => {
    it("drains data added during replay exactly once and in order", async () => {
        const queue: TerminalAppend[] = [
            { data: bytes("a"), startOffset: 0, endOffset: 1 },
            { data: bytes("b"), startOffset: 1, endOffset: 2 },
        ];
        const writes: string[] = [];
        await drainTerminalAppendQueue(queue, async (append) => {
            writes.push(new TextDecoder().decode(append.data));
            if (writes.length === 1) {
                queue.push({ data: bytes("c"), startOffset: 2, endOffset: 3 });
                await Promise.resolve();
            }
        });
        expect(writes).toEqual(["a", "b", "c"]);
        expect(queue).toEqual([]);
    });

    it("reconciles snapshot overlap and concurrent live output without loss or duplication", async () => {
        let currentOffset = 6;
        let restored = "abcdef";
        const queue: TerminalAppend[] = [
            { data: bytes("efgh"), startOffset: 4, endOffset: 8 },
            { data: bytes("ij"), startOffset: 8, endOffset: 10 },
        ];

        await drainTerminalAppendQueue(queue, async (append) => {
            const decision = reconcileTerminalAppend(currentOffset, append);
            expect(decision.kind).toBe("write");
            if (decision.kind !== "write") return;
            restored += new TextDecoder().decode(decision.data);
            currentOffset = decision.endOffset ?? currentOffset + decision.data.byteLength;
        });

        expect(restored).toBe("abcdefghij");
        expect(currentOffset).toBe(10);
    });
});

describe("embedded terminal bounds", () => {
    it("caps xterm scrollback at 5000 only in embedded mode", () => {
        expect(boundEmbeddedScrollback(50_000, true)).toBe(EmbeddedTerminalHistoryMaxLines);
        expect(boundEmbeddedScrollback(50_000, false)).toBe(50_000);
        expect(boundEmbeddedScrollback(900, true)).toBe(900);
    });

    it("chooses the largest valid serialized scrollback under 256 KiB", () => {
        const calls: number[] = [];
        const result = serializeBoundedTerminalState((options) => {
            const scrollback = options?.scrollback ?? EmbeddedTerminalHistoryMaxLines;
            calls.push(scrollback);
            return "x".repeat(scrollback * 64);
        });

        expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(EmbeddedTerminalHistoryMaxBytes);
        expect(result.length).toBe(4096 * 64);
        expect(calls.length).toBeLessThan(20);
    });

    it("uses UTF-8 byte length and falls back to an empty safe cache", () => {
        const oversizedBaseScreen = "🙂".repeat(EmbeddedTerminalHistoryMaxBytes);
        expect(serializeBoundedTerminalState(() => oversizedBaseScreen)).toBe("");
    });
});

describe("embedded surface activity", () => {
    it("reads host-owned activity and fails malformed bridges closed", () => {
        expect(
            readEmbeddedSurfaceActivity({
                hyprlaneWave: { isSurfaceActive: () => true },
            })
        ).toBe(true);
        expect(
            readEmbeddedSurfaceActivity({
                hyprlaneWave: { isSurfaceActive: () => "true" },
            })
        ).toBe(false);
        expect(readEmbeddedSurfaceActivity({})).toBe(false);
    });

    it("subscribes and returns an idempotent host unsubscribe", () => {
        let subscriber: ((active: boolean) => void) | null = null;
        let unsubscribeCount = 0;
        const root = {
            hyprlaneWave: {
                onSurfaceActivityChange(listener: (active: boolean) => void) {
                    subscriber = listener;
                    return () => unsubscribeCount++;
                },
            },
        };
        const changes: boolean[] = [];
        const unsubscribe = subscribeEmbeddedSurfaceActivity((active) => changes.push(active), root);
        subscriber?.(true);
        expect(changes).toEqual([true]);
        unsubscribe();
        unsubscribe();
        expect(unsubscribeCount).toBe(1);
    });
});

describe("hidden terminal replay coalescing", () => {
    it("retains only bounded scalar state for any number of hidden appends", () => {
        const coalescer = new HiddenTerminalReplayCoalescer();
        for (let index = 0; index < 10_000; index += 1) {
            coalescer.mark("append", 7);
        }

        expect(coalescer.dirty).toBe(true);
        expect(coalescer.take()).toEqual({ truncated: false, generation: 7 });
        expect(coalescer.dirty).toBe(false);
        expect(Object.keys(coalescer)).toEqual([]);
    });

    it("preserves truncate/generation and notices changes during a drain", () => {
        const coalescer = new HiddenTerminalReplayCoalescer();
        coalescer.mark("truncate", 8);
        expect(coalescer.take()).toEqual({ truncated: true, generation: 8 });

        coalescer.mark("append", 8);
        expect(coalescer.take()).toEqual({ truncated: false, generation: 8 });
        expect(coalescer.take()).toBeNull();
    });
});
