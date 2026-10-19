import { isVtvMode, isVtvTerminalStatus, VTV_PIPELINE_VERSION } from "./constants.mjs";

function cleanReasons(reasons) {
  return [...new Set((Array.isArray(reasons) ? reasons : [reasons])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean))].slice(0, 24);
}

/**
 * A VTV result is publishable only after every hard gate has passed.  Advisory
 * metrics can keep an output for listening review, but can never manufacture
 * a completed result.
 */
export function decideVtvOutcome({
  mode,
  strictValidationAccepted = false,
  finalMixGatePassed = true,
  advisoryAccepted = false,
  technicalError = false,
  cancelled = false,
  reasons = []
} = {}) {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  if (!isVtvMode(normalizedMode)) throw new Error(`Unsupported VTV mode: ${mode}`);
  const normalizedReasons = cleanReasons(reasons);
  if (cancelled) return { status: "cancelled", completed: false, strictValidationAccepted: false, reasons: normalizedReasons };
  if (technicalError) return { status: "failed", completed: false, strictValidationAccepted: false, reasons: normalizedReasons };
  if (strictValidationAccepted !== true) {
    return {
      status: advisoryAccepted ? "needs-review" : "rejected",
      completed: false,
      strictValidationAccepted: false,
      reasons: normalizedReasons.length ? normalizedReasons : ["strict_validation_failed"]
    };
  }
  if (normalizedMode === "song" && finalMixGatePassed !== true) {
    return { status: "rejected", completed: false, strictValidationAccepted: true, reasons: normalizedReasons.length ? normalizedReasons : ["final_mix_gate_failed"] };
  }
  return { status: "completed", completed: true, strictValidationAccepted: true, reasons: normalizedReasons };
}

export function assertVtvCompletedInvariant(result = {}) {
  if (String(result.status || "") === "completed"
    && (result.strictValidationAccepted !== true || result.finalMixGatePassed === false)) {
    const error = new Error("VTV completed invariant violated: a strict or final-mix gate failed.");
    error.code = "VTV_COMPLETED_INVARIANT_VIOLATION";
    throw error;
  }
  return result;
}

export function vtvTerminalStatusForJob({ mode, strictValidationAccepted, finalMixGatePassed, advisoryAccepted, reasons } = {}) {
  const outcome = decideVtvOutcome({ mode, strictValidationAccepted, finalMixGatePassed, advisoryAccepted, reasons });
  assertVtvCompletedInvariant(outcome);
  return outcome;
}

export function isVtvJobTerminal(status) {
  return isVtvTerminalStatus(status);
}

export const VTV_STATE_MACHINE_VERSION = VTV_PIPELINE_VERSION;
