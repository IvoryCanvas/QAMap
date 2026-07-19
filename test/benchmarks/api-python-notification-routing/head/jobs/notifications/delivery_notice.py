def delivery_destination(delivery_id, fallback_url, dashboard_url):
    if dashboard_url:
        return f"{dashboard_url}/deliveries/{delivery_id}"
    return fallback_url
