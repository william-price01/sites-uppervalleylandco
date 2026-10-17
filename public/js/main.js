// Upper Valley Land Clearing — shared UI behavior
// Mobile nav, lead form submission.

// ---- Mobile nav ----
const navToggle = document.getElementById("nav-toggle");
const navMenu = document.getElementById("nav-menu");
if (navToggle && navMenu) {
  navToggle.addEventListener("click", () => {
    const open = navMenu.classList.toggle("hidden");
    navToggle.setAttribute("aria-expanded", String(!open));
  });
}

// ---- Lead form (Web3Forms) ----
// Key for info@uppervalleylandclearing.com, created 2026-10-09.
const WEB3FORMS_KEY = "8ed4241b-45ef-4fdb-8c8c-c02a16ff8217";

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
      setStatus("Form not connected yet — call us instead: (509) 260-9126", false);
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
        setStatus("Something went wrong — call us instead: (509) 260-9126", false);
      }
    } catch {
      setStatus("Network error — call us instead: (509) 260-9126", false);
    } finally {
      btn.disabled = false;
    }
  });
});

// ---- Footer year ----
document.querySelectorAll("[data-year]").forEach((el) => {
  el.textContent = new Date().getFullYear();
});
