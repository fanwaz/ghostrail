import { useCallback, useEffect, useState } from "react";
import { Button, FlatList, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import QRCode from "react-native-qrcode-svg";
import {
  CLOCK_NOT_SYNCED_MESSAGE,
  encodeRequest,
  verifySignedPayment,
  type PaymentRecord,
  type PaymentRequest,
} from "@ghostrail/core";
import { createMerchant, type Merchant } from "./src/merchant";
import { PayerScreen } from "./src/PayerScreen";
import { createPaymentRequest } from "./src/requests";
import { classifyScan } from "./src/scan";
import { Scanner } from "./src/Scanner";

/**
 * Minimal merchant screen: show a request QR, scan (or paste) the signed payment, settle.
 * All times come from the merchant's network-synced clock.
 *
 * TODO(nav): split into screens once there is more than one flow.
 */
export default function App() {
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [amount, setAmount] = useState("");
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [signedXdr, setSignedXdr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState<"merchant" | "payer">("merchant");
  const [clockSynced, setClockSynced] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (m: Merchant) => setPayments(await m.queue.list()), []);

  useEffect(() => {
    let current: Merchant | null = null;
    createMerchant(() => current && void refresh(current))
      .then(async (m) => {
        current = m;
        setMerchant(m);
        setClockSynced(m.clock.isSynced);
        await refresh(m);
        await m.syncClock(); // best effort; a persisted earlier sync covers offline launches
        setClockSynced(m.clock.isSynced);
      })
      .catch((err: unknown) => setMessage(`Failed to open queue: ${String(err)}`));
  }, [refresh]);

  const syncNow = async () => {
    if (!merchant) return;
    const ok = await merchant.syncClock();
    setClockSynced(merchant.clock.isSynced);
    setMessage(ok ? "Clock synced with the Stellar network" : "Still offline — connect to sync");
  };

  const createRequest = () => {
    if (!merchant) return;
    try {
      setRequest(createPaymentRequest(merchant.clock, amount));
      setMessage("");
    } catch (err) {
      setMessage(String(err));
    }
  };

  const accept = async (xdr: string) => {
    if (!merchant || !request) return;
    try {
      const { duplicate } = await merchant.queue.enqueue(verifySignedPayment(xdr.trim(), request, merchant.clock.now));
      setMessage(duplicate ? "Already received" : "Queued — settles when online");
      setSignedXdr("");
      setRequest(null);
    } catch (err) {
      setMessage(String(err));
    }
  };

  const onScan = (data: string) => {
    setScanning(false);
    const scan = classifyScan(data);
    if (scan.kind === "payment") void accept(scan.xdr);
    else setMessage(scan.kind === "request" ? "That is a payment request, not a signed payment" : "Not a GhostRail payment");
  };

  const settle = async () => {
    if (!merchant) return;
    const report = await merchant.settle();
    setClockSynced(merchant.clock.isSynced);
    setMessage(
      `settled ${report.settled.length}, failed ${report.failed.length}, expired ${report.expired.length}, ` +
        `pending ${report.pending.length}${report.errors.length ? `, errors ${report.errors.length}` : ""}`,
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <Text style={styles.title}>GhostRail (testnet)</Text>
      <View style={styles.row}>
        <Button title="Merchant" onPress={() => setMode("merchant")} disabled={mode === "merchant"} />
        <Button title="Payer" onPress={() => setMode("payer")} disabled={mode === "payer"} />
      </View>

      {mode === "payer" ? (
        <PayerScreen />
      ) : (
      <>
      {!clockSynced && (
        <View style={styles.row}>
          <Text style={styles.warn}>{CLOCK_NOT_SYNCED_MESSAGE}.</Text>
          <Button title="Sync now" onPress={syncNow} disabled={!merchant} />
        </View>
      )}
      <View style={styles.row}>
        <TextInput style={styles.input} placeholder="Amount (XLM)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <Button title="Request" onPress={createRequest} disabled={!merchant || !clockSynced} />
      </View>

      {request && !scanning && (
        <View style={styles.request}>
          <QRCode value={encodeRequest(request)} size={220} />
          <Button title="Scan signed payment" onPress={() => setScanning(true)} />
          {/* Fallback for emulators and testing without a second device. */}
          <TextInput style={styles.input} placeholder="…or paste signed transaction XDR" value={signedXdr} onChangeText={setSignedXdr} multiline />
          <Button title="Accept pasted payment" onPress={() => accept(signedXdr)} />
        </View>
      )}
      {request && scanning && <Scanner onScan={onScan} onCancel={() => setScanning(false)} />}

      <Button title="Settle now" onPress={settle} disabled={!merchant} />
      {message ? <Text style={styles.message}>{message}</Text> : null}

      <FlatList
        data={payments}
        keyExtractor={(p) => p.hash}
        renderItem={({ item }) => (
          <View style={styles.payment}>
            <Text>{item.amount} XLM · {item.state}</Text>
            <Text style={styles.mono}>{item.hash.slice(0, 16)}…{item.ledger ? ` ledger ${item.ledger}` : ""}</Text>
          </View>
        )}
      />
      </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, borderWidth: 1, borderColor: "#999", borderRadius: 6, padding: 8 },
  mono: { fontFamily: "monospace", fontSize: 12 },
  message: { color: "#555" },
  warn: { flex: 1, color: "#b45309" },
  request: { gap: 8, alignItems: "center" },
  payment: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
});
