/* Setup-page shared primitives: safe DOM construction and danger guards.
   All dynamic data goes through textContent / createElement — never innerHTML. */

/** Escape a value for safe interpolation into an HTML text context or a
    double-quoted attribute. Coerces null/undefined to an empty string so
    `${escapeHtml(x)}` never renders the literal "null"/"undefined". */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Create an element with optional className, textContent, and attributes. */
export function el(tag, { className, text, attrs, children } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value != null) node.setAttribute(key, String(value));
    }
  }
  if (children) {
    for (const child of children) {
      if (child) node.appendChild(child);
    }
  }
  return node;
}

/** Set textContent on an element, creating a text node safely. */
export function setText(node, value) {
  if (node) node.textContent = value ?? "";
}

/** Remove all children from a container. */
export function clear(node) {
  if (node) node.replaceChildren();
}

/** Build a notice element: <div class="notice notice-{kind}"> with safe text. */
export function notice(kind, message) {
  return el("p", { className: `notice notice-${kind}`, text: message });
}

/** Build a view-head block: h2 title + optional lead paragraph. */
export function viewHead(title, lead) {
  const children = [el("h2", { text: title })];
  if (lead) children.push(el("p", { className: "view-lead", text: lead }));
  return el("div", { className: "view-head", children: [el("div", { children })] });
}

let guardSeq = 0;

/** Pure two-step confirm state machine — no DOM, unit-testable.
    attemptConfirm returns the outcome of a confirm click given the typed
    value (ignored when no typedPhrase was configured). */
export function createDangerGuardState({ typedPhrase } = {}) {
  let armed = false;
  return {
    get armed() {
      return armed;
    },
    arm() {
      armed = true;
    },
    disarm() {
      armed = false;
    },
    attemptConfirm(typed) {
      if (!armed) return { confirmed: false, armed: false, mismatch: false };
      if (typedPhrase && String(typed ?? "").trim() !== typedPhrase) {
        return { confirmed: false, armed: true, mismatch: true };
      }
      armed = false;
      return { confirmed: true, armed: false, mismatch: false };
    },
  };
}

/**
 * Two-step inline danger guard. First click arms: the button label becomes
 * the confirm label and the full consequence is rendered inline, associated
 * to the button via aria-describedby. Optional typed-phrase mode requires
 * the user to type a confirmation string before it will confirm. Escape
 * disarms. No alert(), no modal — purely inline DOM.
 *
 * A single keydown listener is attached to the button at setup; the typed
 * input is ephemeral and carries its own one listener, so re-arming never
 * accumulates duplicate listeners. Returns { disarm } for onHide cleanup.
 */
export function dangerGuard(button, { consequence, confirmLabel, typedPhrase, onConfirm }) {
  const state = createDangerGuardState({ typedPhrase });
  const originalLabel = button.textContent;
  const consequenceId = `danger-consequence-${++guardSeq}`;
  let consequenceEl = null;
  let input = null;

  function removeConsequence() {
    if (consequenceEl) {
      consequenceEl.remove();
      consequenceEl = null;
    }
    button.removeAttribute("aria-describedby");
  }

  function disarm() {
    state.disarm();
    button.textContent = originalLabel;
    button.classList.remove("danger-guard-armed");
    removeConsequence();
    if (input) {
      input.remove();
      input = null;
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape" && state.armed) {
      e.preventDefault();
      disarm();
    }
  }
  button.addEventListener("keydown", onKeydown);

  function arm() {
    state.arm();
    button.textContent = confirmLabel ?? "Confirm";
    button.classList.add("danger-guard-armed");

    consequenceEl = el("p", { className: "danger-guard-consequence", text: consequence });
    consequenceEl.id = consequenceId;
    button.setAttribute("aria-describedby", consequenceId);
    button.after(consequenceEl);

    if (typedPhrase) {
      input = el("input", {
        className: "danger-guard-input",
        attrs: {
          type: "text",
          placeholder: `Type "${typedPhrase}" to confirm`,
          "aria-label": `Type ${typedPhrase} to confirm`,
          autocomplete: "off",
        },
      });
      input.addEventListener("keydown", onKeydown);
      consequenceEl.after(input);
      input.focus();
    }
  }

  button.addEventListener("click", () => {
    if (!state.armed) {
      arm();
      return;
    }
    const result = state.attemptConfirm(input ? input.value : undefined);
    if (!result.confirmed) {
      if (input && result.mismatch) input.classList.add("danger-guard-mismatch");
      return;
    }
    disarm();
    onConfirm?.();
  });

  return { disarm };
}
