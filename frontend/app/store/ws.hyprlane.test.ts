// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { WSControl } from "./ws";

describe("WSControl host-policy errors", () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("does not route a protocol error frame through the RPC callback", () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const control = new WSControl("http://127.0.0.1", "test", callback);

        control.onmessage({
            data: JSON.stringify({ type: "error", error: "denied by host policy" }),
        } as MessageEvent);

        expect(callback).not.toHaveBeenCalled();
    });
});
