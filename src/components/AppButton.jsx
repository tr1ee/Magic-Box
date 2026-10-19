export function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

export function AppButton({ children, className, tone = "secondary", type = "button", ...props }) {
  return (
    <button className={classNames("app-button", `app-button-${tone}`, className)} type={type} {...props}>
      {children}
    </button>
  );
}
