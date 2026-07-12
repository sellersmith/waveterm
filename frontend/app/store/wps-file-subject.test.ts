// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getFileSubject, publishFileSubject } from "./wps";

const appendEvent: WSFileEventData = {
    zoneid: "zone",
    filename: "term",
    fileop: "append",
    data64: "YQ==",
    startoffset: 0,
    endoffset: 1,
};

describe("file subjects", () => {
    it("publishes only to acquired subjects without creating hidden replay buffers", () => {
        const received: WSFileEventData[] = [];
        const subject = getFileSubject(appendEvent.zoneid, appendEvent.filename);
        const subscription = subject.subscribe((event) => received.push(event));
        publishFileSubject(appendEvent);
        expect(received).toEqual([appendEvent]);

        subscription.unsubscribe();
        subject.release();
        publishFileSubject(appendEvent);

        const reacquired = getFileSubject(appendEvent.zoneid, appendEvent.filename);
        expect(reacquired.refCount).toBe(1);
        reacquired.release();
    });
});
