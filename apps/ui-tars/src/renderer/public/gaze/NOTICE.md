WebGazer.js downloaded from https://webgazer.cs.brown.edu/webgazer.js on 2026-11-17.
Copyright Brown WebGazer Team. Original license header retained in webgazer.js.
This is an experimental local integration, not a relicensing of WebGazer under Apache-2.0.
Upstream header states GPLv3 with an LGPLv3 provision for companies valued below $1M.
Review upstream licensing before distribution/commercial integration.
The library may download TensorFlow face model assets on first use; camera frames are processed locally.

MediaPipe face_mesh assets are vendored from npm @mediapipe/face_mesh@0.4.1633559619.
Package metadata is retained in face_mesh/package.json. These assets are loaded locally to avoid dynamic external script failures.
Local modification: expose getCurrentEyeFeatures() for calibration quality gating before a regression prediction exists. Original WebGazer license remains applicable.
Local modification: regression calibrationBufferSize parameter (default remains 50) allows automatic nine-point calibration to retain all 180 samples. CYRVIS configures capacity 200 and checks per-target coverage before validation.
