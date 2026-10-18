import { useCallback, useEffect, useState } from "react";
import { Button, FlatList, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  encodeRequest,
  systemClock,
  verifyPayment,
  type PaymentRecord,
  type PaymentRequest,
} from "@ghostrail/core";
import { MERCHANT_ADDRESS, REQUEST_TTL_SECONDS } from "./src/config";
import { createMerchant, type Merchant } from "./src/merchant";

/**
 * Minimal merchant screen: create a request, accept a signed payment, settle.
 *
 * TODO(qr): render `encoded` as a QR code and scan the customer's signed XDR (expo-camera).
 * TODO(nav): split into screens once there is more than one flow.
 */
export default function App() {
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [amount, setAmount] = useState("");
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [signedXdr, setSignedXdr] = useState("");
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
    try {
      const next: PaymentRequest = {
        v: 1,
        id: `r-${Date.now().toString(36)}`,
        destination: MERCHANT_ADDRESS,
        amount,
        asset: "native",
        expiresAt: systemClock() + REQUEST_TTL_SECONDS,
      };
      encodeRequest(next); // validates
      setRequest(next);
      setMessage("");
    } catch (err) {
      setMessage(String(err));
    }
  };

  const accept = async () => {
    if (!merchant || !request) return;
    try {
      const { duplicate } = await merchant.queue.enqueue(verifyPayment(signedXdr.trim(), request));
      setMessage(duplicate ? "Already received" : "Queued — settles when online");
      setSignedXdr("");
      setRequest(null);
    } catch (err) {
      setMessage(String(err));
    }
  };

  const settle = async () => {
    if (!merchant) return;
    const report = await merchant.settler.runOnce();
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
        <Button title="Request" onPress={createRequest} />
      </View>

      {request && (
        <View>
          <Text selectable style={styles.mono}>{encodeRequest(request)}</Text>
          <TextInput style={styles.input} placeholder="Paste signed transaction XDR" value={signedXdr} onChangeText={setSignedXdr} multiline />
          <Button title="Accept payment" onPress={accept} />
        </View>
      )}

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
  payment: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
});
