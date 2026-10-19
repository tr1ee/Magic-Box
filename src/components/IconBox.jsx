import { CheckSquare, Square } from "lucide-react";

export default function IconBox({ checked, muted = false }) {
  if (checked) {
    return <CheckSquare aria-hidden="true" size={22} />;
  }
  return <Square aria-hidden="true" className={muted ? "muted-icon" : ""} size={22} />;
}
