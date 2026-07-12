import * as Notifications from "expo-notifications";

export async function scheduleSummaryReminder(surveyId: string, scheduledAt: Date) {
  return Notifications.scheduleNotificationAsync({
    content: {
      title: "Summary ready",
      data: { surveyId },
    },
    trigger: { date: scheduledAt },
  });
}

export async function resyncSummaryReminder(surveyId: string, scheduledAt: Date) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  return scheduleSummaryReminder(surveyId, scheduledAt);
}

export function openLinkedSummary(response: Notifications.NotificationResponse) {
  const surveyId = response.notification.request.content.data.surveyId;
  return `/summaries/${surveyId}`;
}
