import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import QRCode from "react-native-qrcode-svg";
import { toHex } from "@ghostrail/core";
import { Scanner } from "../Scanner";
import {
  AUTO_CHECKS,
  QR_RENDER_CHECK,
  QR_SCAN_CHECK,
  checkQrDataUrl,
  checkScannedPayload,
  makeSelfTestPayload,
  runCheck,
  type CheckResult,
} from "./checks";

/** The parts of react-native-svg's ref we use. */
interface SvgRef {
  toDataURL(callback: (base64: string) => void): void;
}

/**
 * Dev-only on-device checks. Run it on two devices and scan each other's
 * code to cover the camera. Results are also logged with a [selftest] prefix.
 */
export function SelfTestScreen() {
  const nonce = useMemo(() => toHex(Crypto.getRandomBytes(8)), []);
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [scanning, setScanning] = useState(false);
  const svg = useRef<SvgRef | null>(null);

  const record = useCallback((result: CheckResult) => {
    console.log(`[selftest] ${result.status.toUpperCase()} ${result.name}: ${result.detail}`);
    setResults((r) => ({ ...r, [result.name]: result }));
  }, []);

  const runAuto = useCallback(async () => {
    for (const check of AUTO_CHECKS) record(await runCheck(check));
  }, [record]);

  const runQrRender = useCallback(() => {
    void runCheck({
      name: QR_RENDER_CHECK,
      run: () =>
        new Promise<string>((resolve, reject) => {
          if (!svg.current) return reject(new Error("QR component did not mount"));
          const timer = setTimeout(() => reject(new Error("toDataURL timed out")), 5_000);
          svg.current.toDataURL((base64) => {
            clearTimeout(timer);
            try {
              resolve(checkQrDataUrl(base64));
            } catch (err) {
              reject(err);
            }
          });
        }),
    }).then(record);
  }, [record]);

  useEffect(() => {
    void runAuto();
  }, [runAuto]);

  const onScan = (data: string) => {
    setScanning(false);
    void runCheck({ name: QR_SCAN_CHECK, run: async () => checkScannedPayload(data, nonce) }).then(record);
  };

  const names = [...AUTO_CHECKS.map((c) => c.name), QR_RENDER_CHECK, QR_SCAN_CHECK];

  return (
    <View style={styles.root}>
      {names.map((name) => {
        const r = results[name];
        return (
          <View key={name} style={styles.row}>
            <Text style={[styles.badge, r?.status === "pass" ? styles.pass : r ? styles.fail : styles.pending]}>
              {r ? r.status.toUpperCase() : "…"}
            </Text>
            <View style={styles.text}>
              <Text>{name}</Text>
              {r && <Text style={styles.detail}>{r.detail} ({r.ms} ms)</Text>}
            </View>
          </View>
        );
      })}

      <Button title="Re-run automatic checks" onPress={() => void runAuto()} />

      {scanning ? (
        <Scanner onScan={onScan} onCancel={() => setScanning(false)} />
      ) : (
        <View style={styles.qr}>
          <Text>Show this to the other device:</Text>
          <QRCode value={makeSelfTestPayload(nonce)} size={180} getRef={(ref: SvgRef | null) => (svg.current = ref)} />
          <Button title="Check QR render" onPress={runQrRender} />
          <Button title="Scan the other device's code" onPress={() => setScanning(true)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  row: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  badge: { width: 48, fontWeight: "700" },
  pass: { color: "#15803d" },
  fail: { color: "#b91c1c" },
  pending: { color: "#6b7280" },
  text: { flex: 1 },
  detail: { fontSize: 12, color: "#555" },
  qr: { gap: 8, alignItems: "center" },
});
