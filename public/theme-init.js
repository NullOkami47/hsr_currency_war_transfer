(() => {
  let stored;
  try {
    stored = localStorage.getItem("currency-war-theme");
  } catch {
    stored = null;
  }
  const theme = ["light", "dark"].includes(stored)
    ? stored
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#111714" : "#eee8da");
})();
