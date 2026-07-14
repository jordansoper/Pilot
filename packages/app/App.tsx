import { StatusBar } from 'expo-status-bar';
import {
  BackHandler,
  Platform,
  SafeAreaView,
  StatusBar as RNStatusBar,
  StyleSheet,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import type { Screen } from './src/types.js';
import { MachinesScreen } from './src/screens/MachinesScreen.js';
import { AddMachineScreen } from './src/screens/AddMachineScreen.js';
import { SettingsScreen } from './src/screens/SettingsScreen.js';
import { SessionsScreen } from './src/screens/SessionsScreen.js';
import { FilePickerScreen } from './src/screens/FilePickerScreen.js';
import { ToolPickerScreen } from './src/screens/ToolPickerScreen.js';
import { TerminalScreen } from './src/screens/TerminalScreen.js';

const HOME: Screen = { name: 'machines' };

/**
 * pilot-app root.
 *
 * Hand-rolled navigation stack (an array of screens). A stack — rather than a
 * single current-screen — gives real "back" behaviour: a visible back button
 * and the Android hardware back button both pop to the previous screen, and
 * only exit the app from the home screen. Still lighter than react-navigation
 * for this handful of screens.
 */
export default function App() {
  const [stack, setStack] = useState<Screen[]>([HOME]);
  const current = stack[stack.length - 1] ?? HOME;

  const push = useCallback((screen: Screen) => setStack((s) => [...s, screen]), []);
  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);
  // Replace the top screen (e.g. folder picker → terminal), so Back skips it.
  const replace = useCallback(
    (screen: Screen) => setStack((s) => [...s.slice(0, -1), screen]),
    [],
  );
  const goHome = useCallback(() => setStack([HOME]), []);

  // Android hardware back: pop the stack; only let the OS exit from home.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        back();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length, back]);

  return (
    <SafeAreaView style={styles.root}>
      {/* Dark app background → light status-bar icons so the clock/battery
          stay visible. */}
      <StatusBar style="light" />
      {current.name === 'machines' && (
        <MachinesScreen
          onAddMachine={() => push({ name: 'addMachine' })}
          onOpenMachine={(machineId) => push({ name: 'sessions', machineId })}
          onOpenSettings={() => push({ name: 'settings' })}
        />
      )}
      {current.name === 'addMachine' && (
        <AddMachineScreen onDone={back} onCancel={back} />
      )}
      {current.name === 'settings' && <SettingsScreen onBack={back} onReset={goHome} />}
      {current.name === 'sessions' && (
        <SessionsScreen
          machineId={current.machineId}
          onBack={back}
          onOpenSession={(sessionId) =>
            push({ name: 'terminal', machineId: current.machineId, sessionId })
          }
          onNewSession={() => push({ name: 'toolPicker', machineId: current.machineId })}
        />
      )}
      {current.name === 'toolPicker' && (
        <ToolPickerScreen
          machineId={current.machineId}
          onBack={back}
          onPick={(tool) =>
            push({ name: 'filePicker', machineId: current.machineId, tool })
          }
        />
      )}
      {current.name === 'filePicker' && (
        <FilePickerScreen
          machineId={current.machineId}
          onBack={back}
          onPick={(cwd) =>
            replace({ name: 'terminal', machineId: current.machineId, cwd, tool: current.tool })
          }
        />
      )}
      {current.name === 'terminal' && (
        <TerminalScreen
          machineId={current.machineId}
          sessionId={current.sessionId}
          cwd={current.cwd}
          tool={current.tool}
          onBack={back}
        />
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
