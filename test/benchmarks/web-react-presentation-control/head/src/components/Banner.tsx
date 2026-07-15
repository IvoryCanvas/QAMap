export function Banner() {
  const shouldUseDarkText = true;
  return <p className={shouldUseDarkText ? "text-dark" : "text-light"}>Account notice</p>;
}
