// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HiddenTerminalReplayCoalescer } from "./terminal-replay";
import { TermWrap } from "./termwrap";

function visibleSurface(active: boolean): void {
    vi.stubGlobal("window", {
        hyprlaneWave: {
            isSurfaceActive: () => active,
        },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("embedded terminal replay", () => {
    it("allows a visible split pane to replay before it receives focus", () => {
        visibleSurface(true);
        const nodeModel = { isFocused: atom(false) } as BlockNodeModel;

        expect(TermWrap.prototype.isActiveForReplay.call({ nodeModel } as TermWrap)).toBe(true);
    });

    it("coalesces an append that reaches the write queue after the surface hides", async () => {
        visibleSurface(false);
        const terminal = Object.create(TermWrap.prototype) as TermWrap;
        const write = vi.fn(async () => undefined);
        const scheduleDrain = vi.fn();
        Object.assign(terminal, {
            disposed: false,
            loaded: true,
            ptyGeneration: null,
            ptyOffset: 0,
            hiddenReplayChanges: new HiddenTerminalReplayCoalescer(),
            hiddenReplayDrainScheduled: false,
            doTerminalWrite: write,
            isActiveForReplay: () => false,
            scheduleHiddenTerminalDrain: scheduleDrain,
        });

        await terminal.applyTerminalAppend({ data: new Uint8Array([1]), startOffset: 0, endOffset: 1 });

        expect(write).not.toHaveBeenCalled();
        expect(terminal.hiddenReplayChanges.take()).toEqual({ truncated: false, generation: null });
        expect(scheduleDrain).toHaveBeenCalledOnce();
    });
});
