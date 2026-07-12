// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./modalsrenderer.tsx", import.meta.url), "utf8");

describe("Hyprlane hosted modal policy", () => {
    it("keeps upstream onboarding and upgrade modals out of the embedded renderer", () => {
        expect(source).toContain("function isHyprlaneEmbedded()");
        expect(source).toContain("if (!embedded && newInstallOnboardingOpen)");
        expect(source).toContain("if (!embedded && upgradeOnboardingOpen)");
        expect(source).toContain("if (!embedded && !clientData.tosagreed)");
    });
});
