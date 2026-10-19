export default function RvcModelBindingPanel({ model, onImport }) {
  return (
    <div className="voice-vtv-model-binding">
      <strong>RVC v2 target model</strong>
      <span>{model?.modelId || "No .pth + .index model bound"}</span>
      <button type="button" onClick={onImport}>Import model</button>
    </div>
  );
}
