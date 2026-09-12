import type { CapacitorConfig } from "@capacitor/cli";

// Design ref: 02_design.md section 6.15.4. Wraps the existing Vite build
// (`dist/`) as-is -- no separate Capacitor-only build, no plugins, no
// native code of our own. `androidScheme: "https"` matches what
// DeviceOrientationEvent expects (sim/tiltInput.ts) and is Capacitor's
// documented default for Android anyway; stated explicitly so it doesn't
// silently change if that default ever does.
const config: CapacitorConfig = {
  appId: "com.patakuti.gradientcircuit",
  appName: "Gradient Circuit",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
