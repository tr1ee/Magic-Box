import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vtvRvcEngineId, vtvSeedEngineId, vtvYingMusicEngineId } from "../shared/voiceClone.mjs";
import VtvEngineSelector from "../src/components/voice/VtvEngineSelector.jsx";
import VtvEngineStatusCard from "../src/components/voice/VtvEngineStatusCard.jsx";
import VtvProfileEngineMatrix from "../src/components/voice/VtvProfileEngineMatrix.jsx";
import VtvComparisonResults from "../src/components/voice/VtvComparisonResults.jsx";

afterEach(cleanup);

describe("Song VTV target readiness", () => {
  it("does not label a runtime-only engine as ready", () => {
    render(<VtvEngineSelector
      mode="single"
      selectedEngineIds={[vtvRvcEngineId]}
      onModeChange={vi.fn()}
      onToggleEngine={vi.fn()}
      health={{ [vtvRvcEngineId]: { available: true, workerReady: true } }}
      targets={{ [vtvRvcEngineId]: { ready: false } }}
    />);
    expect(screen.getByText("Target required")).toBeInTheDocument();
    expect(screen.queryByText(/^Ready$/)).not.toBeInTheDocument();
  });

  it("shows a bound model and lets the user rebuild a YingMusic reference", async () => {
    const user = userEvent.setup();
    const onBuildReference = vi.fn();
    const { rerender } = render(<VtvEngineStatusCard
      engine={{ id: vtvRvcEngineId, displayName: "RVC v2", capabilities: { requiresTargetModel: true } }}
      state={{ available: true, runtimeVersion: "2.3.260718" }}
      targetState={{ ready: true, targets: [{ artifactId: "model-a", ready: true }] }}
      selectedTargetId="model-a"
    />);
    expect(screen.getByText("Target ready")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "model-a · ready" })).toBeInTheDocument();

    rerender(<VtvEngineStatusCard
      engine={{ id: vtvYingMusicEngineId, displayName: "YingMusic-SVC", capabilities: { requiresReference: true } }}
      state={{ available: true, runtimeVersion: "pinned" }}
      targetState={{ ready: false, targets: [], errors: ["YingMusic reference artifact is not bound."] }}
      onBuildReference={onBuildReference}
    />);
    await user.click(screen.getByRole("button", { name: "Build reference" }));
    expect(onBuildReference).toHaveBeenCalledOnce();
  });

  it("keeps Seed-VC available as the default engine", () => {
    render(<VtvEngineSelector
      mode="single"
      selectedEngineIds={[vtvSeedEngineId]}
      onModeChange={vi.fn()}
      onToggleEngine={vi.fn()}
      health={{ [vtvSeedEngineId]: { available: true } }}
      targets={{ [vtvSeedEngineId]: { ready: true } }}
    />);
    expect(screen.getByText(/^Ready$/)).toBeInTheDocument();
  });

  it("shows measured target identity and applied pitch for song results", () => {
    render(<VtvComparisonResults results={[{
      engineId: vtvRvcEngineId,
      executionStatus: "succeeded",
      qualityStatus: "rejected",
      identity: { targetSimilarity: 0.42, targetSimilarityFloor: 0.61, encoderB: { score: 0.51, targetSimilarityFloor: 0.55 } },
      pitch: { expectedShiftSemitones: 9 }
    }]} />);
    expect(screen.getByText("Target identity A 0.420 / required 0.610")).toBeInTheDocument();
    expect(screen.getByText("Target identity B 0.510 / required 0.550")).toBeInTheDocument();
    expect(screen.getByText("Applied pitch +9 semitones")).toBeInTheDocument();
  });

  it("shows all three targets for a legacy profile and submits a browser RVC bundle", async () => {
    const user = userEvent.setup();
    const onImportRvc = vi.fn().mockResolvedValue(true);
    const onOpenProfiles = vi.fn();
    const onContinue = vi.fn();
    render(<VtvProfileEngineMatrix
      profileName="Ameath2"
      profileStats={{ sampleCount: 6, preparedSourceCount: 6, eligibleClipCount: 4, eligibleSpeechSeconds: 180 }}
      health={{
        [vtvSeedEngineId]: { available: true, runtimeVersion: "seed" },
        [vtvRvcEngineId]: { available: true, runtimeVersion: "2.3.260718" },
        [vtvYingMusicEngineId]: { available: true, runtimeVersion: "pinned" }
      }}
      states={{
        [vtvSeedEngineId]: { ready: true, selectedTarget: { artifactId: "seed-a", label: "Quick version" } },
        [vtvRvcEngineId]: { ready: false, errors: ["RVC target is not bound."], migration: { trainingReadiness: { voicedDurationSec: 180, ready: false } } },
        [vtvYingMusicEngineId]: { ready: false, errors: ["Reference is not bound."], migration: { canBuild: true, eligibleClipCount: 4, availableDurationSec: 24.6 } }
      }}
      summary={{ readyCount: 1, legacyProfile: true }}
      onBuildSeed={vi.fn()}
      onImportRvc={onImportRvc}
      onBuildYing={vi.fn()}
      onOpenProfiles={onOpenProfiles}
      onContinue={onContinue}
    />);

    expect(screen.getByText("VTV Models for Ameath2")).toBeInTheDocument();
    expect(screen.getByText("Older profile · optional VTV upgrade")).toBeInTheDocument();
    expect(screen.getByText("What each engine needs")).toBeInTheDocument();
    expect(screen.getByText("Trained automatically from approved Profile clips")).toBeInTheDocument();
    expect(screen.getByText(/This page does not retrain or replace the model used by Text to Voice/)).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getAllByText(/3\.0 min/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Create reference automatically" })).toBeEnabled();

    expect(screen.queryByLabelText("Trained model (.pth)")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Add audio or verify transcripts" })).toBeEnabled();
    await user.click(screen.getByText("Advanced · import a model trained elsewhere"));

    await user.upload(screen.getByLabelText("Trained model (.pth)"), new File(["model"], "ameath2.pth"));
    await user.upload(screen.getByLabelText("Matching feature index (.index)"), new File(["index"], "ameath2.index"));
    await user.click(screen.getByRole("button", { name: "Verify and bind RVC model" }));
    expect(onImportRvc).toHaveBeenCalledWith(expect.objectContaining({
      modelFile: expect.objectContaining({ name: "ameath2.pth" }),
      indexFile: expect.objectContaining({ name: "ameath2.index" })
    }));

    await user.click(screen.getByRole("button", { name: "Manage source material" }));
    expect(onOpenProfiles).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /Continue to Voice to Voice/ }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("starts automatic RVC training when the Profile has ten approved minutes", async () => {
    const user = userEvent.setup();
    const onTrainRvc = vi.fn();
    render(<VtvProfileEngineMatrix
      profileName="Ready Voice"
      states={{
        [vtvSeedEngineId]: { ready: true },
        [vtvRvcEngineId]: {
          ready: false,
          migration: {
            eligibleClipCount: 96,
            trainingReadiness: { voicedDurationSec: 612, missingVoicedDurationSec: 0, ready: true }
          }
        },
        [vtvYingMusicEngineId]: { ready: false, migration: { canBuild: false, availableDurationSec: 0 } }
      }}
      summary={{ readyCount: 1 }}
      onTrainRvc={onTrainRvc}
      onOpenProfiles={vi.fn()}
    />);

    expect(screen.getByText("Profile is ready for RVC training")).toBeInTheDocument();
    expect(screen.getByText(/RVC trains directly from approved Profile clips/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Train RVC from this Profile" }));
    expect(onTrainRvc).toHaveBeenCalledOnce();
  });

  it("explains that newly approved clips require a new RVC training run", () => {
    render(<VtvProfileEngineMatrix
      profileName="Existing RVC Voice"
      states={{
        [vtvSeedEngineId]: { ready: true },
        [vtvRvcEngineId]: {
          ready: true,
          selectedTarget: { artifactId: "rvc-existing", label: "Existing model" },
          migration: {
            eligibleClipCount: 120,
            trainingReadiness: { voicedDurationSec: 900, missingVoicedDurationSec: 0, ready: true }
          }
        },
        [vtvYingMusicEngineId]: { ready: false, migration: { canBuild: false, availableDurationSec: 0 } }
      }}
      summary={{ readyCount: 2 }}
      onTrainRvc={vi.fn()}
      onOpenProfiles={vi.fn()}
    />);

    expect(screen.getByText(/New clips do not change the currently bound RVC model automatically/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Train a new RVC model" })).toBeEnabled();
  });
});
