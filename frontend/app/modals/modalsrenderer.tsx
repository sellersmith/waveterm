// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { NewInstallOnboardingModal } from "@/app/onboarding/onboarding";
import { CurrentOnboardingVersion } from "@/app/onboarding/onboarding-common";
import { UpgradeOnboardingModal } from "@/app/onboarding/onboarding-upgrade";
import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { atoms, globalPrimaryTabStartup } from "@/store/global";
import { modalsModel } from "@/store/modalmodel";
import * as jotai from "jotai";
import { useEffect } from "react";
import * as semver from "semver";
import { getModalComponent } from "./modalregistry";

function isHyprlaneEmbedded(): boolean {
    return (
        typeof window !== "undefined" &&
        (window as Window & { hyprlaneWave?: unknown }).hyprlaneWave != null
    );
}

const ModalsRenderer = () => {
    const embedded = isHyprlaneEmbedded();
    const clientData = jotai.useAtomValue(ClientModel.getInstance().clientAtom);
    const [newInstallOnboardingOpen, setNewInstallOnboardingOpen] = jotai.useAtom(modalsModel.newInstallOnboardingOpen);
    const [upgradeOnboardingOpen, setUpgradeOnboardingOpen] = jotai.useAtom(modalsModel.upgradeOnboardingOpen);
    const [modals] = jotai.useAtom(modalsModel.modalsAtom);
    const rtn: React.ReactElement[] = [];
    for (const modal of modals) {
        const ModalComponent = getModalComponent(modal.displayName);
        if (ModalComponent) {
            rtn.push(<ModalComponent key={modal.displayName} {...modal.props} />);
        }
    }
    if (!embedded && newInstallOnboardingOpen) {
        rtn.push(<NewInstallOnboardingModal key={NewInstallOnboardingModal.displayName} />);
    }
    if (!embedded && upgradeOnboardingOpen) {
        rtn.push(<UpgradeOnboardingModal key={UpgradeOnboardingModal.displayName} />);
    }
    useEffect(() => {
        if (!embedded && !clientData.tosagreed) {
            setNewInstallOnboardingOpen(true);
        }
    }, [clientData, embedded, setNewInstallOnboardingOpen]);

    useEffect(() => {
        if (embedded || !globalPrimaryTabStartup) {
            return;
        }
        if (!clientData.tosagreed) {
            return;
        }
        const lastVersion = clientData.meta?.["onboarding:lastversion"] ?? "v0.0.0";
        if (semver.lt(lastVersion, CurrentOnboardingVersion)) {
            setUpgradeOnboardingOpen(true);
        }
    }, [embedded, setUpgradeOnboardingOpen]);
    useEffect(() => {
        globalStore.set(atoms.modalOpen, rtn.length > 0);
    }, [rtn]);

    return <>{rtn}</>;
};

export { ModalsRenderer };
