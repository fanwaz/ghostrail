import { useCallback, useEffect, useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { horizonPayerSource, type PayerSnapshot, type PayerWallet, type SignedPayment } from "@ghostrail/core";
import { formatAgo, formatLastKnownBalance } from "./format";
import { reviewRequest, type RequestReview } from "./payerFlow";
import { createPayer, fundWithFriendbot } from "./payerWallet";
import { Scanner } from "./Scanner";

const TICK_MS = 30_000;

/**
 * Payer mode: lets this device act as the customer for demos and testing.
 * Scan a request QR → review it → sign offline → show the signed QR to the merchant.
 *
 * TODO(payer-app): a standalone customer wallet replaces this screen.
 */
export function PayerScreen() {
  const [payer, setPayer] = useState<{ wallet: PayerWallet; publicKey: string } | null>(null);
  const [snapshot, setSnapshot] = useState<PayerSnapshot | undefined>();
  const [now, setNow] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [review, setReview] = useState<RequestReview | null>(null);
  const [signed, setSigned] = useState<SignedPayment | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (wallet: PayerWallet) => {
    setSnapshot(await wallet.snapshot());
    setNow((await wallet.clock())());
  }, []);

  useEffect(() => {
    createPayer()
      .then(async (p) => {
        setPayer(p);
        await refresh(p.wallet);
      })
      .catch((err: unknown) => setMessage(`Failed to open wallet: ${String(err)}`));
  }, [refresh]);

  // Keeps "synced … ago" and the expiry countdown current.
  useEffect(() => {
    if (!payer) return;
    const timer = setInterval(() => void refresh(payer.wallet), TICK_MS);
    return () => clearInterval(timer);
  }, [payer, refresh]);

  const run = (action: () => Promise<unknown>) => async () => {
    setMessage("");
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
    if (payer) await refresh(payer.wallet);
  };

  const sync = run(async () => {
    await payer!.wallet.sync(horizonPayerSource());
  });
  const fund = run(async () => {
    await fundWithFriendbot(payer!.publicKey);
    await payer!.wallet.sync(horizonPayerSource());
  });
  const onScan = (data: string) => {
    setScanning(false);
    void run(async () => {
      setReview(reviewRequest(data, (await payer!.wallet.clock())(), payer!.publicKey));
    })();
  };
  const sign = run(async () => {
    setSigned(await payer!.wallet.pay(review!.request));
    setReview(null);
  });

  if (!payer) return <Text>{message || "Opening wallet…"}</Text>;

  return (
    <View style={styles.root}>
      <Text style={styles.mono} selectable>{payer.publicKey}</Text>

      {snapshot ? (
        <Text>{formatLastKnownBalance(snapshot, now)}</Text>
      ) : (
        <Text style={styles.warn}>Connect once to sync this wallet before signing payments.</Text>
      )}
      <View style={styles.row}>
        <Button title="Sync" onPress={sync} />
        <Button title="Fund (testnet)" onPress={fund} />
      </View>

      {signed ? (
        <View style={styles.center}>
          <Text>Show this to the merchant:</Text>
          <QRCode value={signed.xdr} size={260} />
          <Button title="Done" onPress={() => setSigned(null)} />
        </View>
      ) : review ? (
        <View style={styles.center}>
          <Text>
            Pay {review.request.amount} {review.request.asset === "native" ? "XLM" : review.request.asset.split(":")[0]}
          </Text>
          <Text style={styles.mono}>to {review.request.destination}</Text>
          <Text>Expires in {formatAgo(review.expiresInSeconds)}</Text>
          <Button title="Sign offline" onPress={sign} />
          <Button title="Cancel" onPress={() => setReview(null)} />
        </View>
      ) : scanning ? (
        <Scanner onScan={onScan} onCancel={() => setScanning(false)} />
      ) : (
        <Button title="Scan payment request" onPress={() => setScanning(true)} disabled={!snapshot} />
      )}

      {message ? <Text style={styles.warn}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  row: { flexDirection: "row", gap: 8 },
  center: { gap: 8, alignItems: "center" },
  mono: { fontFamily: "monospace", fontSize: 12 },
  warn: { color: "#b45309" },
});
