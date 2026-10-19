import { useEffect, useRef } from "react";
import { GripVertical } from "lucide-react";
import { classNames } from "./AppButton.jsx";

export default function SplitHandle({ className, label, maximum, minimum, onReset, onResize, testId, value }) {
  const cleanupDragRef = useRef(null);

  useEffect(() => () => cleanupDragRef.current?.(), []);

  function handlePointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    cleanupDragRef.current?.();
    let lastPoint = event.clientX;

    function handleWindowPointerMove(moveEvent) {
      const delta = moveEvent.clientX - lastPoint;
      lastPoint = moveEvent.clientX;
      onResize(delta);
    }

    function finishResize() {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.body.classList.remove("is-resizing-pane");
      cleanupDragRef.current = null;
    }

    cleanupDragRef.current = finishResize;
    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    event.currentTarget.focus();
    document.body.classList.add("is-resizing-pane");
    event.preventDefault();
  }

  function handleKeyDown(event) {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!direction) {
      return;
    }
    event.preventDefault();
    onResize(direction * (event.shiftKey ? 40 : 16));
  }

  return (
    <div
      className={classNames("split-handle", className)}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={minimum}
      aria-valuenow={Math.round(value)}
      data-testid={testId}
      tabIndex={0}
      title={`${label}. Drag, use arrow keys, or double-click to reset.`}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
    >
      <span aria-hidden="true"><GripVertical size={16} /></span>
    </div>
  );
}
