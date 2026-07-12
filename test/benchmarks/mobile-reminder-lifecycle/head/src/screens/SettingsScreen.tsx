import { Switch, View } from "react-native";

export function SettingsScreen() {
  return (
    <View>
      <Switch accessibilityLabel="Summary reminder" testID="summary-reminder-toggle" value />
    </View>
  );
}
