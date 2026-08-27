import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function ensureFramekitWindowVisible(run = execFile) {
  try {
    const result = await run("osascript", ["-e", overlayAccessibilityScript]);
    if (result.stdout.trim() !== "false") {
      throw new Error("FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE");
    }
    return false;
  } catch (error) {
    throw overlayAccessibilityError(error);
  }
}

export const overlayAccessibilityScript = `
tell application "System Events"
  if not (exists process "Final Cut Pro") then error "FINAL_CUT_E2E_FINAL_CUT_PROCESS_MISSING"
  tell process "Final Cut Pro"
    set framekitWindow to missing value
    repeat with candidateWindow in windows
      try
        set candidateWindowName to name of candidateWindow as text
        if candidateWindowName contains "Framekit" then
          set framekitWindow to contents of candidateWindow
          exit repeat
        end if
      end try
    end repeat

    if framekitWindow is missing value then
      set overlayInOtherProcess to false
      repeat with candidateProcess in processes
        try
          set candidateProcessName to name of candidateProcess as text
          if candidateProcessName is not "Final Cut Pro" then
            repeat with candidateWindow in windows of candidateProcess
              try
                if (name of candidateWindow as text) contains "Framekit" then
                  set overlayInOtherProcess to true
                  exit repeat
                end if
              end try
            end repeat
          end if
          if overlayInOtherProcess then exit repeat
        end try
      end repeat
      if overlayInOtherProcess then error "FINAL_CUT_E2E_OVERLAY_WRONG_PROCESS"
      error "FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING"
    end if

    set overlayMinimizationFailed to false
    try
      set value of attribute "AXMinimized" of framekitWindow to false
      delay 0.2
    on error
      set overlayMinimizationFailed to true
    end try
    if overlayMinimizationFailed then error "FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE"
    return (value of attribute "AXMinimized" of framekitWindow) as text
  end tell
end tell`;

function overlayAccessibilityError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("FINAL_CUT_E2E_ACCESSIBILITY_PERMISSION_REQUIRED")
    || /not authorized|-1743|-25211/i.test(detail)) {
    return new Error("FINAL_CUT_E2E_ACCESSIBILITY_PERMISSION_REQUIRED: grant Accessibility permission to the headed test host in System Settings > Privacy & Security > Accessibility");
  }
  if (detail.includes("FINAL_CUT_E2E_FINAL_CUT_PROCESS_MISSING")) {
    return new Error("FINAL_CUT_E2E_FINAL_CUT_PROCESS_MISSING: open Final Cut Pro and the Framekit Workflow Extension, then retry");
  }
  if (detail.includes("FINAL_CUT_E2E_OVERLAY_WRONG_PROCESS")) {
    return new Error("FINAL_CUT_E2E_OVERLAY_WRONG_PROCESS: the Framekit window is outside Final Cut Pro; open the extension from Window > Extensions > Framekit");
  }
  if (detail.includes("FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE")) {
    return new Error("FINAL_CUT_E2E_OVERLAY_NOT_VISIBLE: the Framekit window could not be made visible; open the extension and retry");
  }
  if (detail.includes("FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING")) {
    return new Error("FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING: open the Framekit extension in Final Cut Pro and retry");
  }
  return new Error("FINAL_CUT_E2E_OVERLAY_ACCESSIBILITY_FAILED: verify Accessibility permission and that the Framekit extension is hosted by Final Cut Pro, then retry");
}
