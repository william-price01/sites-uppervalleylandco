// Upper Valley Land Clearing — shared UI behavior
// Mobile nav, before/after sliders, lead form submission.

// ---- Mobile nav ----
const navToggle = document.getElementById("nav-toggle");
const navMenu = document.getElementById("nav-menu");
if (navToggle && navMenu) {
  navToggle.addEventListener("click", () => {
    const open = navMenu.classList.toggle("hidden");
    navToggle.setAttribute("aria-expanded", String(!open));
  });
}

// ---- Before/after sliders ----
// Any element with [data-ba] becomes draggable. Images must share aspect ratio.
document.querySelectorAll("[data-ba]").forEach((slider) => {
  const setPos = (clientX) => {
    const rect = slider.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    slider.style.setProperty("--pos", `${Math.min(97, Math.max(3, pct))}%`);
  };

  let dragging = false;
  slider.addEventListener("pointerdown", (e) => {
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    setPos(e.clientX);
  });
  slider.addEventListener("pointermove", (e) => dragging && setPos(e.clientX));
  slider.addEventListener("pointerup", () => (dragging = false));
  slider.addEventListener("pointercancel", () => (dragging = false));
});

// ---- Lead form (Web3Forms) ----
// SETUP: create a free key at https://web3forms.com (owner's email) and paste below.
const WEB3FORMS_KEY = "YOUR_WEB3FORMS_ACCESS_KEY";

document.querySelectorAll("form[data-lead]").forEach((form) => {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = form.querySelector("[data-status]");
    const btn = form.querySelector("button[type=submit]");
    const setStatus = (msg, ok) => {
      if (!status) return;
      status.textContent = msg;
      status.className = ok
        ? "mt-3 text-sm font-medium text-forest-600"
        : "mt-3 text-sm font-medium text-red-600";
    };

    if (WEB3FORMS_KEY === "YOUR_WEB3FORMS_ACCESS_KEY") {
      setStatus("Form not connected yet — call us instead: (555) 555-0123", false);
      return;
    }

    btn.disabled = true;
    setStatus("Sending…", true);
    try {
      const data = new FormData(form);
      data.append("access_key", WEB3FORMS_KEY);
      const res = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        body: data,
      });
      const json = await res.json();
      if (json.success) {
        form.reset();
        setStatus("Thanks — we'll be in touch within one business day.", true);
      } else {
        setStatus("Something went wrong. Please call us instead.", false);
      }
    } catch {
      setStatus("Network error — please call us instead.", false);
    } finally {
      btn.disabled = false;
    }
  });
});

// ---- Footer year ----
document.querySelectorAll("[data-year]").forEach((el) => {
  el.textContent = new Date().getFullYear();
});
