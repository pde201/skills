// Recorded-shape tool outputs used by the tests. Small but structurally
// faithful: a headline, a long routine middle, and a summary at the end —
// which is exactly the shape that makes blind truncation lose the answer.

const repeat = (line, n) => Array.from({ length: n }, (_, i) => line.replace("%d", i)).join("\n");

export const npmInstall = [
  "npm warn deprecated inflight@1.0.6: This module is not supported",
  repeat("npm http fetch GET 200 https://registry.npmjs.org/pkg-%d 41ms (cache hit)", 120),
  "",
  "added 412 packages, and audited 413 packages in 9s",
  "",
  "52 packages are looking for funding",
  "found 0 vulnerabilities",
].join("\n");

export const jestRun = [
  "PASS src/util/date.test.ts",
  repeat("PASS src/components/Widget%d.test.tsx", 90),
  "FAIL src/api/client.test.ts",
  "  ● client › retries on 503",
  "    expect(received).toBe(expected)",
  "    Expected: 3",
  "    Received: 1",
  "      at Object.<anonymous> (src/api/client.test.ts:88:24)",
  "",
  "Tests:       1 failed, 271 passed, 272 total",
  "Snapshots:   0 total",
  "Time:        18.44 s",
].join("\n");

export const kubectlPods = [
  "NAME                          READY   STATUS             RESTARTS   AGE",
  repeat("web-5d8f%d-abcde              1/1     Running            0          4d", 80),
  "worker-7c9b12-xyz             0/1     CrashLoopBackOff   184        2d",
  repeat("cache-1a2b%d-qrstu            1/1     Running            0          9d", 40),
].join("\n");

export const progressChurn = [
  "Downloading...",
  repeat("\r  45% [=========>          ] 12.4 MB/s", 30),
  "done",
  repeat("identical line", 25),
  "Finished in 3.2s",
].join("\n");
