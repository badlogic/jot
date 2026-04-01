// Web components for jot UI (no shadow DOM)

const ICONS = {
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  logout: '<svg viewBox="0 0 16 16"><path d="M6 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10.5 11.5L14 8l-3.5-3.5M6 8h8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  preview: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  share: '<svg viewBox="0 0 16 16"><circle cx="12" cy="4" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.8 7.1l4.4-2.2M5.8 8.9l4.4 2.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3.5 4.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M6.2 4.5V3.4c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="m5 6.2.5 6.1c0 .4.4.7.8.7h3.4c.4 0 .8-.3.8-.7l.5-6.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="7" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  reply: '<svg viewBox="0 0 16 16"><path d="M6.2 4.2 2.5 8l3.7 3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 8h5.5c2.7 0 4.5 1.2 4.5 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="M3 11.8 3.6 9l5.9-5.9 2.4 2.4L6 11.4 3 11.8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m8.8 3.8 2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="m3.5 8.3 2.6 2.6 6.4-6.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M4.1 6.1V3.3M4.1 3.3H6.9M4.1 3.3 7 6.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8a4.9 4.9 0 1 1-1.3-3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

window.__ICONS__ = ICONS;

// <jot-icon-button icon="plus" label="New note" size="md|sm">
class JotIconButton extends HTMLElement {
  connectedCallback() {
    if (this._rendered) return;
    this._rendered = true;
    const icon = this.getAttribute("icon") || "";
    const label = this.getAttribute("label") || "";
    const size = this.getAttribute("size") || "md";
    const danger = this.hasAttribute("danger");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `jot-btn-icon jot-btn-icon--${size}${danger ? " jot-btn-icon--danger" : ""}`;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.innerHTML = ICONS[icon] || "";
    this.appendChild(btn);
  }
}

// <jot-button variant="primary|ghost|danger|link" size="md|sm">Label</jot-button>
class JotButton extends HTMLElement {
  connectedCallback() {
    if (this._rendered) return;
    this._rendered = true;
    const variant = this.getAttribute("variant") || "default";
    const size = this.getAttribute("size") || "md";
    const label = this.textContent.trim();
    this.textContent = "";
    const btn = document.createElement("button");
    btn.type = this.getAttribute("submit") !== null ? "submit" : "button";
    btn.className = `jot-btn jot-btn--${variant} jot-btn--${size}`;
    btn.textContent = label;
    this.appendChild(btn);
  }
}

customElements.define("jot-icon-button", JotIconButton);
customElements.define("jot-button", JotButton);
