import { useEffect, useRef } from "react";
import { ShieldCheck } from "lucide-react";
import { AppButton } from "./AppButton.jsx";

export default function AccessibleConfirmationDialog({ confirmation, onClose }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    confirmRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialogRef.current.querySelectorAll("button:not([disabled])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  async function confirm() {
    onClose();
    await confirmation.onConfirm();
  }

  return (
    <div className="assistant-dialog-backdrop">
      <section
        aria-describedby="magic-box-confirm-description"
        aria-labelledby="magic-box-confirm-title"
        aria-modal="true"
        className="assistant-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <div className="assistant-dialog-icon"><ShieldCheck size={24} /></div>
        <div>
          <span>Review required</span>
          <h2 id="magic-box-confirm-title">{confirmation.title}</h2>
          <p id="magic-box-confirm-description">{confirmation.description}</p>
        </div>
        <div className="assistant-dialog-actions">
          <AppButton onClick={onClose}>Cancel</AppButton>
          <button className="app-button app-button-danger" ref={confirmRef} type="button" onClick={confirm}>
            {confirmation.confirmLabel || "Confirm"}
          </button>
        </div>
      </section>
    </div>
  );
}
