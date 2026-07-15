import { useState } from "react";

export function NotificationsPage() {
  const [isNotificationReady, setNotificationReady] = useState(false);

  function sendNotification() {
    setNotificationReady(true);
  }

  return (
    <main>
      <h1>Notifications</h1>
      <button type="button" onClick={sendNotification}>Send notification</button>
      {isNotificationReady && <p>Notification queued</p>}
    </main>
  );
}
