// universalScormDebugger.js
// Lightweight SCORM 1.2 + 2004 API shim so SCOs can run
// and so retrieveScormData.js can observe their calls.

console.log("Universal SCORM Debugger Loaded");

(function () {
    // In-memory “LMS” data stores
    var scorm12Data = {};
    var scorm2004Data = {};

    var initialized12 = false;
    var initialized2004 = false;

    // ---------- SCORM 1.2 API ----------
    var API = {
        LMSInitialize: function (param) {
            console.log("SCORM 1.2: LMSInitialize", param);
            initialized12 = true;
            return "true";
        },
        LMSFinish: function (param) {
            console.log("SCORM 1.2: LMSFinish", param);
            return "true";
        },
        LMSGetValue: function (element) {
            console.log("SCORM 1.2: LMSGetValue", element);
            return scorm12Data[element] || "";
        },
        LMSSetValue: function (element, value) {
            console.log("SCORM 1.2: LMSSetValue", element, "=", value);
            scorm12Data[element] = value;
            return "true";
        },
        LMSCommit: function (param) {
            console.log("SCORM 1.2: LMSCommit", param);
            console.log("Current SCORM 1.2 Data:", scorm12Data);
            return "true";
        },
        LMSGetLastError: function () { return "0"; },
        LMSGetErrorString: function (code) { return "No error"; },
        LMSGetDiagnostic: function (code) { return "No diagnostic info"; }
    };

    // ---------- SCORM 2004 API ----------
    var API_1484_11 = {
        Initialize: function (param) {
            console.log("SCORM 2004: Initialize", param);
            initialized2004 = true;
            return "true";
        },
        Terminate: function (param) {
            console.log("SCORM 2004: Terminate", param);
            return "true";
        },
        GetValue: function (element) {
            console.log("SCORM 2004: GetValue", element);
            return scorm2004Data[element] || "";
        },
        SetValue: function (element, value) {
            console.log("SCORM 2004: SetValue", element, "=", value);
            scorm2004Data[element] = value;
            return "true";
        },
        Commit: function (param) {
            console.log("SCORM 2004: Commit", param);
            console.log("Current SCORM 2004 Data:", scorm2004Data);
            return "true";
        },
        GetLastError: function () { return "0"; },
        GetErrorString: function (code) { return "No error"; },
        GetDiagnostic: function (code) { return "No diagnostic info"; }
    };

    // Expose to typical SCORM discovery paths without overwriting a real LMS
    function exposeAPI(name, obj) {
        try {
            var targets = [];
            if (typeof window !== "undefined") targets.push(window);
            try { if (window.parent && window.parent !== window) targets.push(window.parent); } catch (_) { }
            try { if (window.top && window.top !== window) targets.push(window.top); } catch (_) { }
            try { if (window.opener) targets.push(window.opener); } catch (_) { }

            targets.forEach(function (w) {
                if (!w[name]) {
                    w[name] = obj;
                }
            });
        } catch (e) {
            console.warn("Error exposing SCORM API:", e);
        }
    }

    exposeAPI("API", API);
    exposeAPI("API_1484_11", API_1484_11);

    console.log("Universal SCORM Debugger Ready (SCORM 1.2 + 2004)");
})();
