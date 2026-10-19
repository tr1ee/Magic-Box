// All comparison engines must receive the same stems from the requested
// separator. Do not silently force the default Demucs model for modern SVC.
export async function separateSharedSongStems(options, { demucs, roformer }) {
  const settings = options.settings || {};
  const requested = String(settings.separationModel || settings.separation_model || "htdemucs").toLowerCase();
  const useRoformer = ["bs-roformer", "bs_roformer", "roformer", "band-roformer"].includes(requested);
  const model = useRoformer ? "bs-roformer" : requested === "htdemucs_ft" ? "htdemucs_ft" : "htdemucs";
  const result = await (useRoformer ? roformer : demucs)({ ...options, settings: { ...settings, separationModel: model } });
  return {
    ...result,
    separator: {
      strategy: useRoformer ? "shared-bs-roformer" : "shared-demucs",
      model,
      modelSha256: result.separatorModelSha256 || ""
    }
  };
}
