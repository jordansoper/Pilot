import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet } from 'react-native';
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
      <StatusBar style="dark" />
      {screen.name === 'machines' && (
        <MachinesScreen onAddMachine={goAdd} onOpenTerminal={goTerminal} />
      )}
      {screen.name === 'addMachine' && (
        <AddMachineScreen onDone={goMachines} onCancel={goMachines} />
      )}
      {screen.name === 'terminal' && (
        <TerminalScreen
          machineId={screen.machineId}
          onBack={goMachines}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f1115',
  },
});
