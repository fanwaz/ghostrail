import { useRef } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

/** Full-width QR scanner. Calls `onScan` once per mount with the raw QR text. */
export function Scanner({ onScan, onCancel }: { onScan: (data: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false); // the camera fires repeatedly for the same code

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={styles.box}>
        <Text>Camera access is needed to scan the customer's payment.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
        <Button title="Cancel" onPress={onCancel} />
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <CameraView
        style={styles.camera}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          done.current = true;
          onScan(data);
        }}
      />
      <Button title="Cancel" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  camera: { width: "100%", aspectRatio: 1 },
});
