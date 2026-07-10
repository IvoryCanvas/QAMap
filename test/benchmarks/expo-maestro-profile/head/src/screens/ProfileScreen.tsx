import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

export function ProfileScreen() {
  const [displayName, setDisplayName] = useState("");
  const [saved, setSaved] = useState(false);

  async function saveProfile() {
    const response = await fetch("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    });
    setSaved(response.ok);
  }

  return (
    <View>
      <Text>Profile</Text>
      <TextInput
        accessibilityLabel="Display name"
        placeholder="Display name"
        value={displayName}
        onChangeText={setDisplayName}
      />
      <Pressable accessibilityLabel="Save profile" testID="profile-save" onPress={saveProfile}>
        <Text>Save profile</Text>
      </Pressable>
      {saved ? <Text>Profile saved</Text> : null}
    </View>
  );
}
