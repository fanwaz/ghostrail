import { useCallback, useEffect, useState } from "react";
import { Button, FlatList, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import QRCode from "react-native-qrcode-svg";
import {
  encodeRequest,
  verifySignedPayment,
  type PaymentRecord,
  type PaymentRequest,
} from "@ghostrail/core";
import { MERCHANT_ADDRESS, REQUEST_TTL_SECONDS } from "./src/config";
import { createMerchant, type Merchant } from "./src/merchant";
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
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (m: Merchant) => setPayments(await m.queue.list()), []);

  useEffect(() => {
    let current: Merchant | null = null;
    createMerchant(() => current && void refresh(current))
      .then((m) => {
        current = m;
        setMerchant(m);
        return refresh(m);
      })
      .catch((err: unknown) => setMessage(`Failed to open queue: ${String(err)}`));
  }, [refresh]);

  const createRequest = () => {
    if (!merchant) return;
    try {
      const next: PaymentRequest = {
        v: 1,
        id: `r-${Date.now().toString(36)}`,
        destination: MERCHANT_ADDRESS,
        amount,
        asset: "native",
        expiresAt: merchant.clock.now() + REQUEST_TTL_SECONDS,
      };
      encodeRequest(next); // validates
      setRequest(next);
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
    setMessage(
      `settled ${report.settled.length}, failed ${report.failed.length}, expired ${report.expired.length}, ` +
        `pending ${report.pending.length}${report.errors.length ? `, errors ${report.errors.length}` : ""}`,
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <Text style={styles.title}>GhostRail Merchant (testnet)</Text>

      <View style={styles.row}>
        <TextInput style={styles.input} placeholder="Amount (XLM)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <Button title="Request" onPress={createRequest} disabled={!merchant} />
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
  request: { gap: 8, alignItems: "center" },
  payment: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
});
