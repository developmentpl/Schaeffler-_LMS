// retrieveScormData.js
// - Wraps SCORM 1.2 & 2004 APIs (Initialize/Finish/Terminate, SetValue, GetValue, Commit)
// - Mirrors values into memory + emits a debug stream (BroadcastChannel/localStorage)
// - ALSO sends normalized score/duration/status to parent via postMessage("SCORM_DATA")

(function () {
    const CHANNEL_NAME = "scorm-debug";
    const SUPPORTS_BC = typeof window.BroadcastChannel !== "undefined";
    const bc = SUPPORTS_BC ? new BroadcastChannel(CHANNEL_NAME) : null;

    // Local mirrors for SCORM values
    const mirror12 = {};
    const mirror2004 = {};

    // attempt/session id for grouping events
    const attemptId =
        sessionStorage.getItem("SCORM_ATTEMPT_ID") ||
        (() => {
            const id = "attempt_" + new Date().toISOString();
            sessionStorage.setItem("SCORM_ATTEMPT_ID", id);
            return id;
        })();

    // shallow copy of current state for this API version
    function snapshot(version) {
        return version === "1.2" ? { ...mirror12 } : { ...mirror2004 };
    }

    // Send debug event (for dashboards / logs)
    function emit(payload) {
        const evt = {
            ...payload,
            attemptId,
            ts: Date.now(),
        };

        if (bc) {
            bc.postMessage(evt);
        } else {
            // Fallback: write to localStorage so other tabs can listen via 'storage' events
            try {
                const key = "SCORM_DEBUG_STREAM";
                localStorage.setItem(key, JSON.stringify(evt));
                // Persist latest full state as well
                localStorage.setItem(
                    "SCORM_DEBUG_STATE",
                    JSON.stringify({
                        attemptId,
                        v12: mirror12,
                        v2004: mirror2004,
                        ts: Date.now(),
                    })
                );
            } catch (e) {
                // ignore quota issues
            }
        }
    }

    // Pick out Score, Status, Duration from the mirrors
    function buildSummary() {
        let apiVersion = "";
        let raw = "";
        let status = "";
        let duration = "";

        // Prefer 2004 if any values exist, else fall back to 1.2
        const has2004 = Object.keys(mirror2004).length > 0;
        const has12 = Object.keys(mirror12).length > 0;

        if (has2004) {
            apiVersion = "2004";
            raw = mirror2004["cmi.score.raw"] || "";

            const success = mirror2004["cmi.success_status"] || "";
            const completion = mirror2004["cmi.completion_status"] || "";
            status = success || completion || "";

            duration =
                mirror2004["cmi.session_time"] ||
                mirror2004["cmi.total_time"] ||
                "";
        } else if (has12) {
            apiVersion = "1.2";
            raw = mirror12["cmi.core.score.raw"] || "";
            status = mirror12["cmi.core.lesson_status"] || "";
            duration =
                mirror12["cmi.core.session_time"] ||
                mirror12["cmi.core.total_time"] ||
                "";
        }

        return {
            apiVersion,
            Score: raw,
            posttestScore: raw,
            Status: status,
            duration: duration,
        };
    }

    // Send normalized summary to parent (scormview.html)
    function sendToParent(reason) {
        try {
            const target = window.parent || window.top;
            if (!target || target === window) return;

            const origin =
                window.location.origin && window.location.origin !== "null"
                    ? window.location.origin
                    : "*";

            const summary = buildSummary();
            const payload = {
                type: "SCORM_DATA",
                ...summary,
                // also include raw mirrors for future dashboards, if needed
                state12: { ...mirror12 },
                state2004: { ...mirror2004 },
                attemptId,
                reason: reason || "",
                ts: Date.now(),
            };

            target.postMessage(payload, origin);
            // keep a copy for any UIs that want to poll localStorage
            try {
                localStorage.setItem("SCORM_LATEST_PAYLOAD", JSON.stringify(payload));
            } catch (e) { /* ignore */ }

            console.log("SCORM_DATA sent to parent:", payload);
        } catch (e) {
            console.warn("Failed to send SCORM_DATA to parent:", e);
        }
    }

    function isInterestingElement(element) {
        if (!element) return false;
        const e = String(element).toLowerCase();
        return (
            e.includes("score.raw") ||
            e.includes("lesson_status") ||
            e.includes("completion_status") ||
            e.includes("success_status") ||
            e.includes("session_time") ||
            e.includes("total_time")
        );
    }

    // Wrap a method on a target API and emit + optionally send summary
    function wrapMethod(target, methodName, version, impl) {
        if (!target || !target[methodName]) return;
        // Avoid double-wrapping
        if (target[methodName]._wrappedByRetrieve) return;

        const original = target[methodName].bind(target);
        const wrapped = function () {
            const args = Array.from(arguments);
            let ret;
            try {
                ret = original.apply(this, args);
                impl && impl({ args, ret, version, methodName });
            } catch (err) {
                emit({
                    type: "error",
                    apiVersion: version,
                    fn: methodName,
                    args,
                    error: String(err),
                });
                throw err;
            }
            return ret;
        };
        wrapped._wrappedByRetrieve = true;
        target[methodName] = wrapped;
    }

    // Patch once API objects are present
    function tryPatch() {
        const api12 =
            window.API ||
            (window.top && window.top.API) ||
            (window.parent && window.parent.API);

        const api2004 =
            window.API_1484_11 ||
            (window.top && window.top.API_1484_11) ||
            (window.parent && window.parent.API_1484_11);

        if (api12) {
            // SCORM 1.2
            wrapMethod(api12, "LMSInitialize", "1.2", ({ args, ret }) => {
                emit({
                    type: "initialize",
                    apiVersion: "1.2",
                    fn: "LMSInitialize",
                    args,
                    ret,
                    state: snapshot("1.2"),
                });
            });

            wrapMethod(api12, "LMSSetValue", "1.2", ({ args, ret }) => {
                const [element, value] = args;
                mirror12[element] = value;
                emit({
                    type: "setvalue",
                    apiVersion: "1.2",
                    fn: "LMSSetValue",
                    element,
                    value,
                    ret,
                    state: snapshot("1.2"),
                });
                if (isInterestingElement(element)) {
                    sendToParent("1.2-setvalue-" + element);
                }
            });

            wrapMethod(api12, "LMSGetValue", "1.2", ({ args, ret }) => {
                const [element] = args;
                emit({
                    type: "getvalue",
                    apiVersion: "1.2",
                    fn: "LMSGetValue",
                    element,
                    value: ret,
                    state: snapshot("1.2"),
                });
            });

            wrapMethod(api12, "LMSCommit", "1.2", ({ args, ret }) => {
                emit({
                    type: "commit",
                    apiVersion: "1.2",
                    fn: "LMSCommit",
                    args,
                    ret,
                    state: snapshot("1.2"),
                });
                sendToParent("1.2-commit");
            });

            wrapMethod(api12, "LMSFinish", "1.2", ({ args, ret }) => {
                emit({
                    type: "terminate",
                    apiVersion: "1.2",
                    fn: "LMSFinish",
                    args,
                    ret,
                    state: snapshot("1.2"),
                });
                sendToParent("1.2-finish");
            });
        }

        if (api2004) {
            // SCORM 2004
            wrapMethod(api2004, "Initialize", "2004", ({ args, ret }) => {
                emit({
                    type: "initialize",
                    apiVersion: "2004",
                    fn: "Initialize",
                    args,
                    ret,
                    state: snapshot("2004"),
                });
            });

            wrapMethod(api2004, "SetValue", "2004", ({ args, ret }) => {
                const [element, value] = args;
                mirror2004[element] = value;
                emit({
                    type: "setvalue",
                    apiVersion: "2004",
                    fn: "SetValue",
                    element,
                    value,
                    ret,
                    state: snapshot("2004"),
                });
                if (isInterestingElement(element)) {
                    sendToParent("2004-setvalue-" + element);
                }
            });

            wrapMethod(api2004, "GetValue", "2004", ({ args, ret }) => {
                const [element] = args;
                emit({
                    type: "getvalue",
                    apiVersion: "2004",
                    fn: "GetValue",
                    element,
                    value: ret,
                    state: snapshot("2004"),
                });
            });

            wrapMethod(api2004, "Commit", "2004", ({ args, ret }) => {
                emit({
                    type: "commit",
                    apiVersion: "2004",
                    fn: "Commit",
                    args,
                    ret,
                    state: snapshot("2004"),
                });
                sendToParent("2004-commit");
            });

            wrapMethod(api2004, "Terminate", "2004", ({ args, ret }) => {
                emit({
                    type: "terminate",
                    apiVersion: "2004",
                    fn: "Terminate",
                    args,
                    ret,
                    state: snapshot("2004"),
                });
                sendToParent("2004-terminate");
            });
        }

        // Return true if at least one API patched
        return Boolean(api12 || api2004);
    }

    // Many SCOs load asynchronously; poll until API is exposed.
    // universalScormDebugger.js exposes API objects globally in the window/top/parent scopes.
    let tries = 0;
    const timer = setInterval(() => {
        if (tryPatch() || tries > 200) {
            clearInterval(timer);
            if (tries > 200) {
                emit({
                    type: "warning",
                    message: "SCORM API not found to patch after waiting.",
                });
            }
        }
        tries++;
    }, 50);
})();
