const TEMPLATE = `
  <div class="section-head">
    <div>
      <h2 id="title-activities">Advanced editor</h2>
      <div class="section-lead">Full-fidelity editing for power users: raw roles, per-surface button maps, and JSON. Most people should use the guided setup instead.</div>
    </div>
    <div class="actions">
      <a class="button" href="#activities">‹ All activities</a>
      <a class="button wiz-cta" href="#wizard">Guided setup</a>
      <button id="activityRefresh" type="button" class="secondary">Reload from hub</button>
    </div>
  </div>
  <div class="activity-command">
    <div class="activity-hero">
      <div>
        <div class="activity-eyebrow">Now running</div>
        <h3 id="activityCurrentName">Waiting for hub</h3>
        <div id="activityCurrentMeta" class="activity-current-meta"><span class="activity-live-dot"></span>Current state has not been read yet</div>
      </div>
      <div class="activity-hero-actions">
        <button id="activityRefreshState" type="button">Refresh state</button>
        <button id="activityPowerOff" type="button">Power everything off</button>
      </div>
    </div>
    <div id="activityNotice" class="activity-notice" role="status" aria-live="polite"></div>
    <div class="activity-layout">
      <aside class="panel activity-roster">
        <div class="activity-roster-head">
          <h3>Remote activity order</h3>
          <div class="help">This order is written back to ActivityList and shown on compatible Harmony remotes.</div>
          <div class="activity-roster-actions">
            <button id="activitySync" type="button" class="secondary">Refresh remote locally</button>
          </div>
        </div>
        <div id="activityList" class="activity-list">
          <div class="activity-list-empty">Open Activities to load the hub.</div>
        </div>
      </aside>
      <div class="activity-workspace">
        <div id="activityEmpty" class="panel activity-empty">
          <div>
            <div class="activity-empty-mark">&#9654;</div>
            <h3>Select an activity</h3>
            <div class="muted">Choose an activity from the ordered list to edit its advanced fields. New activities are created with the <a href="#wizard">guided setup</a>.</div>
          </div>
        </div>
        <div id="activityEditor" class="panel activity-editor hidden">
          <div class="activity-editor-head">
            <div>
              <div class="activity-eyebrow" style="color:var(--accent-primary)">Activity editor</div>
              <h3 id="activityEditorTitle">Activity</h3>
              <div id="activityEditorMeta" class="muted mini"></div>
            </div>
            <span id="activityDirty" class="activity-dirty">Unsaved</span>
          </div>
          <div class="activity-tabs" role="tablist">
            <button type="button" class="activity-tab active" data-activity-tab="setup">Devices &amp; inputs</button>
            <button type="button" class="activity-tab" data-activity-tab="buttons">Remote buttons</button>
            <button type="button" class="activity-tab" data-activity-tab="advanced">Advanced JSON</button>
          </div>
          <div class="activity-tab-panel active" data-activity-tab-panel="setup">
            <div class="activity-form-grid">
              <div><label for="activityName">Activity name</label><input id="activityName" maxlength="96"></div>
              <div><label for="activityType">Activity kind</label><select id="activityType"></select></div>
              <div><label for="activityIcon">Icon key</label><input id="activityIcon" placeholder="Optional firmware icon"></div>
              <div><label for="activityDefaultChannel">Default channel</label><input id="activityDefaultChannel" placeholder="Optional"></div>
              <div><label for="activityDefaultStation">Default station name</label><input id="activityDefaultStation" placeholder="Optional"></div>
            </div>
            <div class="activity-section-title">
              <div>
                <h4>Device roles and input routing</h4>
                <div class="help">Roles tell Harmony which device supplies picture, volume, channels, playback, or keyboard input.</div>
              </div>
              <button id="activityAddRole" type="button" class="secondary">Add device role</button>
            </div>
            <div id="activityRoleList" class="activity-role-list"></div>
          </div>
          <div class="activity-tab-panel" data-activity-tab-panel="buttons">
            <div class="callout"><strong>Map the paired remote per surface.</strong> Press, long-press, and double-press assignments are saved in MapList together with the activity.</div>
            <div class="activity-map-toolbar">
              <div><label for="activityMapSelect">Remote surface</label><select id="activityMapSelect"></select></div>
              <div class="actions"><button id="activityClearMap" type="button" class="danger">Clear this surface</button></div>
            </div>
            <div id="activityMapSummary" class="activity-map-summary">No map selected.</div>
            <datalist id="activityCommandCatalog"></datalist>
            <div id="activityButtonList" class="activity-button-list"></div>
          </div>
          <div class="activity-tab-panel" data-activity-tab-panel="advanced">
            <div class="callout"><strong>Full-fidelity editor.</strong> These objects preserve fields the guided editor does not expose, including entry/leave actions, control groups, sequence metadata, and firmware-specific values. Invalid JSON is never sent.</div>
            <div class="activity-raw-grid">
              <div><label for="activityRawActivity">Selected Activity object</label><textarea id="activityRawActivity" spellcheck="false"></textarea></div>
              <div><label for="activityRawMaps">Button maps for this Activity</label><textarea id="activityRawMaps" spellcheck="false"></textarea></div>
              <div class="activity-raw-functions"><label for="activityRawFunctions">Control-group FunctionMap for this Activity</label><textarea id="activityRawFunctions" spellcheck="false"></textarea></div>
            </div>
            <div class="actions">
              <button id="activityApplyRaw" type="button" class="secondary">Apply JSON to working copy</button>
              <a class="button secondary" href="/export/activities">Download ActivityList</a>
              <a class="button secondary" href="/export/maps">Download MapList</a>
              <a class="button secondary" href="/export/functions">Download FunctionList</a>
            </div>
          </div>
          <div class="activity-savebar">
            <div id="activitySaveState" class="activity-save-state">Hub resources match this editor</div>
            <div class="actions">
              <button id="activityRunSelected" type="button" class="ghost">Run</button>
              <button id="activityDuplicate" type="button" class="ghost">Duplicate</button>
              <button id="activityDelete" type="button" class="danger">Delete</button>
              <button id="activitySaveSync" type="button" class="secondary">Save &amp; refresh remote</button>
              <button id="activitySave" type="button">Save to hub</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

let vendorPromise = null;

function ensureStylesheet(href, marker) {
  if (document.querySelector(`link[${marker}]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute(marker, "1");
  // Production bakes activity-overrides.css into /assets/harmony-shell.css,
  // so the vendor sheet must sort BEFORE the shell sheet for overrides to
  // win the cascade. In the sim there is no shell bundle — appending keeps
  // the validated order (vendor, then the separately loaded overrides).
  const shellCss = document.querySelector('link[href="/assets/harmony-shell.css"]');
  if (shellCss) document.head.insertBefore(link, shellCss);
  else document.head.appendChild(link);
}

function loadVendorAssets() {
  if (vendorPromise) return vendorPromise;
  vendorPromise = new Promise((resolve, reject) => {
    // Absolute hub routes: the vendor editor is already embedded in
    // codex_webui and served at /assets/activity-ui.* — never bundled twice.
    ensureStylesheet("/assets/activity-ui.css", "data-activity-vendor");
    if (globalThis.HARMONY_SIM === true) {
      ensureStylesheet("css/activity-overrides.css", "data-activity-overrides");
    }
    if (document.querySelector("script[data-activity-vendor]")) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "/assets/activity-ui.js";
    script.dataset.activityVendor = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load activity editor script"));
    document.body.appendChild(script);
  });
  return vendorPromise;
}

function triggerVendorReload() {
  document.getElementById("activityRefresh")?.click();
}

export function createActivitiesView(section) {
  section.innerHTML = TEMPLATE;

  return {
    async onShow() {
      section.classList.add("active");
      try {
        await loadVendorAssets();
        if (!section.dataset.vendorBooted) {
          section.dataset.vendorBooted = "1";
        } else {
          triggerVendorReload();
        }
      } catch (error) {
        section.innerHTML = `
          <div class="view-head">
            <div>
              <h2>Activities</h2>
              <p class="view-lead">The activity editor could not start.</p>
            </div>
          </div>
          <div class="notice notice-error" role="alert">
            <strong>Editor failed to load.</strong>
            <p>${error.message || "Unknown error"}</p>
            <p class="muted">Reload the page, or open Control to run activities without editing maps.</p>
            <p><a class="btn btn-secondary" href="#control">Open remote</a></p>
          </div>`;
      }
    },
    onHide() {
      section.classList.remove("active");
    },
  };
}
