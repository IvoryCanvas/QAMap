import { Text, View } from "react-native";

export function SurveyCompleteScreen() {
  return (
    <View>
      <Text>Survey complete</Text>
      <Text testID="summary-reminder-preview">Summary reminder scheduled</Text>
    </View>
  );
}
