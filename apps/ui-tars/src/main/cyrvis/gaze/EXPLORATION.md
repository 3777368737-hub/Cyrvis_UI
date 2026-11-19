# Gaze exploration baseline

Base: origin/main 996f3236. Branch: codex/eye-tracking-exploration.

## Existing integration points

- VoiceBrain routes explicit voice tasks to CyrvisController.
- CyrvisController owns execution state; gaze must never independently authorize execution.
- gaze/ currently contains planning only; no camera capture, calibration or tracking exists.
- Current baseline is primarily Windows-tested; macOS camera permission and screen scaling require separate validation.

## First experiment

1. Explicit camera opt-in and local preview; never upload camera frames.
2. Collect nine screen targets with timestamps and calibration samples.
3. Evaluate held-out target error in logical screen pixels, separately from calibration fit.
4. Emit structured samples: timestamp, screenId, x, y, confidence, calibrated.
5. Account for renderer/window coordinates, desktop logical coordinates and screenshot physical pixels.
6. Resolve a stable recent fixation when voice contains a deictic reference; show a candidate highlight and request confirmation.
7. Fall back to click selection or a clarification if confidence is low, calibration is stale or the display changes.

Camera gaze estimation is not yet implemented or measured. Do not describe pointer simulation as eye tracking. Choose a tracker only after checking macOS support, licensing and offline asset availability. Hardware trackers and webcam estimates should share the same sample interface.

## Local reproduction

- pnpm 9.10.0; local Node 22.16.0; macOS arm64.
- Install: PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --frozen-lockfile.
- Build: pnpm --filter ui-tars-desktop build:dist.
- Tests: pnpm exec vitest run --workspace vitest.cyrvis.workspace.ts (57 passing).
- Launch: ./start-cyrvis.command.
- Voice requires QWEN_API_KEY in apps/ui-tars/.env. No real key copied into this checkout.
- Browser operator unavailable on this machine at launch; desktop operator can be configured independently.

## Desktop cursor implementation

- cursor.ts creates a separate 36x36 transparent native BrowserWindow, mouse-through and non-focusable, always-on-top and visible above fullscreen apps/workspaces.
- The tracker renderer submits smoothed positions at at most 20Hz. It remains alive when the main window is hidden (backgroundThrottling=false).
- Native coordinates use the primary display's logical bounds; Retina physical screenshot pixels are not used for window positioning.
- Missing/invalid/old samples hide the cursor after 800ms. Stop/calibration hides it immediately.
- The UI offers an explicit 5-second center preview independent of webcam tracking. This is a display test, not an accuracy measurement.
- Cmd/Ctrl+Alt+G toggles cursor visibility. Camera stop remains separate.
- Only the primary display is calibrated. No promise is made about OS secure screens/lock screen or other monitors.
- 5 added mocked-Electron regression tests cover coordinate mapping, click-through/non-focus windows, staleness, cancelled load, and manual visibility. Human gaze accuracy and continuous cross-app tracking still require real-user validation.

## Automated calibration, validation and smoothing

- Each of nine training targets waits 900ms, then collects 20 eye-feature samples spaced at least 100ms apart. Calibration uses fresh cached eye patches, not predicted gaze, so initial untrained/null predictions do not deadlock training.
- Fresh eye patches, an approximate eyelid-opening ratio >=0.12, and >=400ms stable nose/face scale gate collection. These are experimental heuristics, not a guarantee the user actually looks at the dot. The user must still fixate the displayed target.
- Five different held-out positions collect 20 predictions each. No training calls are made during validation. Report mean, median, P90 distance and per-target mean in logical pixels using raw predictions, including out-of-bounds predictions.
- Current experimental gate: mean <=6% of screen diagonal and P90 <=10%. The score remains unchanged. Failed validation now also offers an explicitly labeled low-accuracy demo mode; the user may choose cursor-only preview instead.
- 1 Euro filter defaults: minimum cutoff 1.2Hz, beta 0.015 (pixel units), derivative cutoff 1Hz. Reset on tracking gaps, lost eyes, restart or calibration; disable WebGazer's extra Kalman stage to avoid double filtering. Tune against measured jitter AND saccade delay.
- Model initialization and cancellation are guarded by a generation counter. Calibration is invalidated on viewport resize.
- The vendored WebGazer includes one explicit local accessor `getCurrentEyeFeatures()` for fresh feature availability before the regression can predict. No camera frames are sent to AI by this accessor.

## Calibration buffer regression fix

A real-user validation report (336px mean, top points much worse than bottom points) led to discovery that WebGazer's InitRegression used a fixed 50-sample ring buffer. The automatic protocol produced 180 samples, evicting most earlier targets. The local vendor patch introduces calibrationBufferSize; CYRVIS sets it to 200 before initializing/clearing regression. Before validation, the app inspects getData() and requires at least 20 stored samples for every training target. A regression test executes the vendored initializer with test dependencies and verifies actual buffer capacities; another reproduces 50-sample eviction and detects incomplete spatial coverage. New real-user validation is needed to measure remaining error; do not reuse or reinterpret the prior score as an accuracy result of the fix.

## Independent bias compensation

A later report showed 130px mean error, 111px centroid-bias RMS and 84px within-target dispersion RMS. This indicates both effects matter; it does not justify reusing validation offsets for calibration. A separate five-target correction phase now follows regression training and precedes held-out validation. Fit a regularized affine map from robust median prediction centers to target locations in normalized screen coordinates. Reject collapsed, reversed or extreme mappings. Never train WebGazer on correction or validation points. The held-out report shows both original and compensated scores on the same unseen validation set before temporal smoothing. Apply the frozen mapping before One Euro filtering during tracking. Actual accuracy improvement is not assumed; only the subsequent held-out result can establish it.

## Read-only AI screen demo

- For the short demo choose **快速体验AI看屏**: perform the nine training targets, then start tracking and on-demand screenshot inspection directly. No correction or validation is run, and the UI states that accuracy is unvalidated. The full training/correction/validation route remains separately available.
- At the end of full calibration choose **开始体验AI看屏（低精度演示）**, even if the accuracy threshold was not met. The primary action is at the top of the completion screen; numerical diagnostics are collapsed. This explicitly enables on-demand screenshot transmission. The report still states the actual measured error.
- Hide the workbench, look at a target on the primary display (including other applications), and say **我在看什么** with voice active, or press **Cmd/Ctrl+Alt+I**. The panel also has a three-second delayed capture button so the user can switch to a different app.
- The latest valid eye estimate is frozen when the request starts. Samples older than 3.5 seconds are rejected. Face/eye validity gates remain, but dispersion no longer blocks this approximate demo.
- Electron captures the primary desktop, selects its exact display ID, maps normalized gaze to actual screenshot pixels, and crops a surrounding region. There is no fallback to an unrelated monitor. Screenshots are held in memory, never written to disk by this feature.
- The crop is sent to the visual model currently configured in Settings using its existing Base URL/key/model. Only explicit inspection requests send images; camera frames stay local. The visual request has no action tools and treats screen text as untrusted data.
- Voice has a dedicated inspect_gaze_target tool plus a deterministic route for the basic gaze question. Concurrent requests share one crop/API request. Sleep/new speech suppresses stale answers. Turning off AI screen sharing aborts the request and clears its preview. The panel retains the last transmitted crop and result while enabled for inspection.
- 2026-11-18 local smoke check: the real primary screen was captured at 1470x956, a 559x402 crop was sent through GazeInspector to the existing configured visual API, and the returned description correctly read the test window title, TEST 731, and red/blue 开始/完成 buttons. This verifies capture/format/model access; the gaze coordinate in that smoke check was a synthetic center coordinate, not a measurement of human gaze. The real-user gaze + microphone + playback experience still needs manual validation.
- Local voice VAD now clears idle audio after a short pre-roll rather than appending silence indefinitely. A regression test sends 40 seconds of silence, verifies the buffered input remains <=1 second, then verifies that the next real speech segment still commits. This prevents the observed 30-second buffer overflow during gaze calibration.
- Camera ownership belongs only to MainLayout, never the task widget's React root. Closing the widget during task cancellation must not run gaze cleanup, clear coordinates, or disable AI screen inspection. Once tracking starts it retains primary-screen calibration coordinates across workbench resize/restore; resizing during calibration still invalidates the calibration targets. Task cancellation and voice sleep do not end the gaze camera session; explicitly close it in the eye panel.
- Regression suite: 88 tests passing, including real React-root widget-close ownership and spoken task cancellation followed by gaze inspection; frontend and main-process TypeScript checks passing. The distribution build also passed.
