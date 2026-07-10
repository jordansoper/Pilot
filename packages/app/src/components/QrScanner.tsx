import { useCallback, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from 'expo-camera';

/**
 * QR-code scanner wrapper around expo-camera's v15 `CameraView`.
 *
 * - Asks for camera permission lazily.
 * - Fires `onScanned(value)` once per unique value within a 2s window so a
 *   camera that keeps emitting the same QR doesn't crash the parent with
 *   duplicate-pair attempts.
 * - Lets the parent render a "manual entry" fallback if permission is denied.
 */
export interface QrScannerProps {
  onScanned: (value: string) => void;
  onError?: (error: string) => void;
}

export function QrScanner({ onScanned, onError }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const lastValueRef = useRef<{ value: string; at: number } | null>(null);
  const [throttledNote, setThrottledNote] = useState<string | null>(null);

  const handleBarcode = useCallback(
    (result: BarcodeScanningResult) => {
      const value = result.data;
      const now = Date.now();
      const last = lastValueRef.current;
      // Throttle: ignore repeats of the same value within 2 seconds.
      if (last && last.value === value && now - last.at < 2_000) {
        setThrottledNote('(re-scan ignored)');
        return;
      }
      lastValueRef.current = { value, at: now };
      setThrottledNote(null);
      try {
        onScanned(value);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err));
      }
    },
    [onScanned, onError],
  );

  if (!permission) {
    return (
      <View style={styles.center}>
        <Text>Requesting camera permission…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>
          Pilot needs the camera to scan pairing QRs from your machines.
        </Text>
        <Button title="Grant camera" onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={styles.scanner}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={handleBarcode}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      />
      <View pointerEvents="none" style={styles.overlay}>
        <View style={styles.frame} />
      </View>
      {throttledNote ? <Text style={styles.throttle}>(re-scan ignored)</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  body: { color: '#fff', textAlign: 'center', marginBottom: 16 },
  scanner: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: '#ffffffcc',
    borderRadius: 16,
  },
  throttle: {
    color: '#888',
    textAlign: 'center',
    padding: 8,
  },
});
