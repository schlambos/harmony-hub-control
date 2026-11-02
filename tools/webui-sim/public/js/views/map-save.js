/* Save a whole MapList through /api/activity-save and say honestly what
   happened. The hub can apply a save and still report a failure (a slow
   engine), so after an error this looks at what the hub has before saying.
   `check(config)` answers "saved" | "unchanged" | "changed" for the config
   the hub has afterwards.
   Returns "saved", "kept" (nothing landed, or the hub is still saving: the
   caller keeps its draft) or "replaced" (the hub has something else now). */

import * as api from "../api.js";
import * as hub from "../state.js";
import { snackbar } from "../ui/shell.js";

export async function saveMapList(mapList, { done, check }) {
  const config = hub.state.config;
  const payload = {
    baseRevision: config.revision,
    activityList: structuredClone(config.activityList),
    mapList,
    functionList: structuredClone(config.functionList),
  };
  try {
    await api.saveActivity(payload);
    await hub.reloadConfig();
    snackbar(done);
    return "saved";
  } catch (error) {
    await hub.reloadConfig();
    const result = hub.state.configError ? "unknown" : check(hub.state.config);
    if (result === "saved") {
      snackbar(`${done} The hub was slow to confirm.`);
      return "saved";
    }
    if (error.status === 504) {
      snackbar("The hub is still saving. Your changes are still here; reload in a minute to see whether they landed before you save again.", { error: true });
      return "kept";
    }
    if (result === "unchanged") {
      snackbar(`Not saved — ${error.message || "hub error"}. Nothing changed on the hub; your changes are still here.`, { error: true });
      return "kept";
    }
    snackbar(`Couldn't save — ${error.message || "hub error"}. This shows what the hub has now.`, { error: true });
    return "replaced";
  }
}
