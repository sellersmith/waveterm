// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

export const EmbeddedTerminalHistoryMaxBytes = 256 * 1024;
export const EmbeddedTerminalHistoryMaxLines = 5000;
export const TerminalReplayChunkBytes = 32 * 1024;
export const TerminalReplayChunksPerFrame = 4;

export type TerminalAppend = {
    data: Uint8Array;
    startOffset?: number;
    endOffset?: number;
    generation?: number;
};

export type TerminalAppendDecision =
    | { kind: "discard" }
    | { kind: "resync" }
    | { kind: "write"; data: Uint8Array; endOffset: number | null };

export type HiddenTerminalReplayChange = {
    truncated: boolean;
    generation: number | null;
};

export class HiddenTerminalReplayCoalescer {
    #dirty = false;
    #truncated = false;
    #generation: number | null = null;

    get dirty(): boolean {
        return this.#dirty;
    }

    mark(fileOp: "append" | "truncate", generation?: number): void {
        this.#dirty = true;
        this.#truncated ||= fileOp === "truncate";
        if (Number.isSafeInteger(generation) && (generation ?? 0) >= 0) {
            this.#generation = generation ?? null;
        }
    }

    take(): HiddenTerminalReplayChange | null {
        if (!this.#dirty) return null;
        const change = {
            truncated: this.#truncated,
            generation: this.#generation,
        };
        this.#dirty = false;
        this.#truncated = false;
        this.#generation = null;
        return change;
    }
}

function validOffset(value: number | undefined): value is number {
    return value != null && Number.isSafeInteger(value) && value >= 0;
}

export function reconcileTerminalAppend(currentOffset: number, append: TerminalAppend): TerminalAppendDecision {
    const hasAnyOffset = append.startOffset != null || append.endOffset != null;
    if (!hasAnyOffset) {
        return { kind: "write", data: append.data, endOffset: null };
    }
    if (
        !validOffset(append.startOffset) ||
        !validOffset(append.endOffset) ||
        append.endOffset < append.startOffset ||
        append.endOffset - append.startOffset !== append.data.byteLength
    ) {
        return { kind: "resync" };
    }
    if (append.endOffset <= currentOffset) {
        return { kind: "discard" };
    }
    if (append.startOffset > currentOffset) {
        return { kind: "resync" };
    }
    return {
        kind: "write",
        data: append.data.subarray(currentOffset - append.startOffset),
        endOffset: append.endOffset,
    };
}

export function terminalGenerationChanged(current: number | null, incoming: number | undefined): boolean {
    return current != null && incoming != null && current !== incoming;
}

export async function drainTerminalAppendQueue(
    queue: TerminalAppend[],
    apply: (append: TerminalAppend) => Promise<void>
): Promise<void> {
    while (queue.length > 0) {
        const append = queue.shift();
        if (append != null) {
            await apply(append);
        }
    }
}

export function isHyprlaneWaveEmbedded(): boolean {
    return typeof window !== "undefined" && (window as Window & { hyprlaneWave?: unknown }).hyprlaneWave != null;
}

type SurfaceActivityRoot = {
    hyprlaneWave?: {
        isSurfaceActive?: unknown;
        onSurfaceActivityChange?: unknown;
    };
};

function defaultSurfaceActivityRoot(): SurfaceActivityRoot {
    return typeof window === "undefined" ? {} : (window as Window & SurfaceActivityRoot);
}

export function readEmbeddedSurfaceActivity(root: SurfaceActivityRoot = defaultSurfaceActivityRoot()): boolean {
    const bridge = root.hyprlaneWave;
    if (typeof bridge?.isSurfaceActive !== "function") return false;
    try {
        return bridge.isSurfaceActive.call(bridge) === true;
    } catch {
        return false;
    }
}

export function subscribeEmbeddedSurfaceActivity(
    listener: (active: boolean) => void,
    root: SurfaceActivityRoot = defaultSurfaceActivityRoot()
): () => void {
    const bridge = root.hyprlaneWave;
    if (typeof bridge?.onSurfaceActivityChange !== "function") return () => {};
    let unsubscribe: unknown;
    try {
        unsubscribe = bridge.onSurfaceActivityChange.call(bridge, listener);
    } catch {
        return () => {};
    }
    let subscribed = true;
    return () => {
        if (!subscribed) return;
        subscribed = false;
        if (typeof unsubscribe === "function") unsubscribe();
    };
}

export function boundEmbeddedScrollback(configured: number, embedded: boolean): number {
    return embedded ? Math.min(configured, EmbeddedTerminalHistoryMaxLines) : configured;
}

type SerializeOptions = { scrollback?: number };

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

export function serializeBoundedTerminalState(
    serialize: (options?: SerializeOptions) => string,
    maxBytes = EmbeddedTerminalHistoryMaxBytes,
    maxScrollback = EmbeddedTerminalHistoryMaxLines
): string {
    const maximumState = serialize({ scrollback: maxScrollback });
    if (utf8Length(maximumState) <= maxBytes) {
        return maximumState;
    }

    const baseState = serialize({ scrollback: 0 });
    if (utf8Length(baseState) > maxBytes) {
        return "";
    }

    let bestState = baseState;
    let low = 1;
    let high = maxScrollback - 1;
    while (low <= high) {
        const candidateScrollback = Math.floor((low + high) / 2);
        const candidateState = serialize({ scrollback: candidateScrollback });
        if (utf8Length(candidateState) <= maxBytes) {
            bestState = candidateState;
            low = candidateScrollback + 1;
        } else {
            high = candidateScrollback - 1;
        }
    }
    return bestState;
}
