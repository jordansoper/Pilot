import { StatusBar } from 'expo-status-bar';
import {
  Platform,
  SafeAreaView,
  StatusBar as RNStatusBar,
  StyleSheet,
} from 'react-native';
import { useCallback, useState } from 'react';
import type { Screen } from './src/types.js';
import { MachinesScreen } from './src/screens/MachinesScreen.js';
import { AddMachineScreen } from './src/screens/AddMachineScreen.js';
import { TerminalScreen } from './src/screens/TerminalScreen.js';

/**
 * pilot-app — Phase 1 root.
 *
 * Hand-rolled 3-screen navigator. State-based switch beats `react-navigation`
 * for a 3-screen flow with no deep nesting, and tucks a future Phase 2 file
 * picker in as another branch on the same `Screen` union.
 */
export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'machines' });

  const goMachines = useCallback(() => setScreen({ name: 'machines' }), []);
  const goAdd = useCallback(() => setScreen({ name: 'addMachine' }), []);
  const goTerminal = useCallback(
    (machineId: string) => setScreen({ name: 'terminal', machineId }),
    [],
  );

  return (
    <SafeAreaView style={styles.root}>
      {/* Dark app background → light status-bar icons so the clock/battery
          stay visible. */}
      <StatusBar style="light" />
      {screen.name === 'machines' && (
        <MachinesScreen onAddMachine={goAdd} onOpenTerminal={goTerminal} />
      )}
      {screen.name === 'addMachine' && (
        <AddMachineScreen onDone={goMachines} onCancel={goMachines} />
      )}
      {screen.name === 'terminal' && (
        <TerminalScreen machineId={screen.machineId} onBack={goMachines} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f1115',
    // `SafeAreaView` from react-native only insets on iOS; on Android it is a
    // plain View, so content would render under the status bar (buttons behind
    // the clock/battery). Pad by the real status-bar height on Android.
    paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0,
  },
});
