const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const panels = Array.from(document.querySelectorAll("[data-panel]"));
const toast = document.querySelector("[data-toast]");
let toastTimer;

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    const selected = button.dataset.tab;

    for (const candidate of tabButtons) {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", String(active));
    }

    for (const panel of panels) {
      panel.hidden = panel.dataset.panel !== selected;
    }
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const container = button.closest(".code-row, .code-block");
    const source = container?.querySelector("[data-copy-value]");
    const value = source?.textContent?.trim();

    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      showToast("Copied to clipboard");
    } catch {
      showToast("Copy failed");
    }
  });
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

fetch("https://api.github.com/repos/Real-Fruit-Snacks/wayback-linker/releases/latest")
  .then((response) => response.ok ? response.json() : Promise.reject())
  .then((release) => {
    const version = release.tag_name?.startsWith("v") ? release.tag_name : `v${release.tag_name}`;
    if (version) document.querySelector("[data-version]").textContent = version;
  })
  .catch(() => {});

if (window.lucide) {
  window.lucide.createIcons({ "stroke-width": 1.8 });
}
