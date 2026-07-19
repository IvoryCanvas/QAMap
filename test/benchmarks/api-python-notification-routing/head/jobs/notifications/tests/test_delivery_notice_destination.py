from jobs.notifications import delivery_notice


def test_delivery_notice_uses_dashboard_when_configured():
    destination = delivery_notice.delivery_destination(
        42,
        "/admin/deliveries/42",
        "https://operations.example",
    )
    assert destination == "https://operations.example/deliveries/42"


def test_delivery_notice_falls_back_to_admin():
    destination = delivery_notice.delivery_destination(
        42,
        "/admin/deliveries/42",
        "",
    )
    assert destination == "/admin/deliveries/42"
